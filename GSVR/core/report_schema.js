(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./score_config.js"));
  } else {
    root.GSVRReportSchema = factory(root.GSVRScoreConfig);
  }
})(typeof self !== "undefined" ? self : this, function (scoreConfig) {
  "use strict";

  const PUBLICATION_DECISION_SCHEMA_VERSION = "gsvr-publication-decision-v2";
  const PROFILE_REPORT_SCHEMA_VERSION = "gsvr-profile-report-v2";

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function cloneArray(value) {
    return Array.isArray(value) ? value.slice() : [];
  }

  function normalizeCompleteness(raw = {}, diagnostics = {}, scores = {}) {
    const input = asObject(raw);
    const total = Number(input.total ?? diagnostics.totalScholarItems ?? 0);
    const scored = Number(input.scored ?? scores.eligibleRankedPublications ?? diagnostics.eligibleRankedPublications ?? 0);
    const dblpMissing = Number(input.dblpMissing ?? diagnostics.dblpMissing ?? diagnostics.missingDblp ?? 0);
    const ambiguous = Number(input.ambiguous ?? diagnostics.ambiguousMatches ?? diagnostics.ambiguous ?? 0);
    const rankNotFound = Number(input.rankNotFound ?? diagnostics.unrankedVenues ?? diagnostics.sourceMissing ?? 0);
    const excludedType = Number(input.excludedType ?? (
      Number(diagnostics.excludedShortPapers ?? 0)
      + Number(diagnostics.excludedWorkshops ?? 0)
      + Number(diagnostics.excludedDemosPosters ?? 0)
      + Number(diagnostics.excludedExtendedAbstracts ?? 0)
      + Number(diagnostics.excludedPreprints ?? 0)
    ));
    const missingAuthorCount = Number(input.missingAuthorCount ?? diagnostics.missingAuthorCount ?? 0);
    const lookupUnavailable = Number(input.lookupUnavailable ?? (
      Number(diagnostics.sourceRateLimited ?? 0)
      + Number(diagnostics.sourceUnavailable ?? 0)
    ));
    const clean = {
      total: Number.isFinite(total) ? total : 0,
      scored: Number.isFinite(scored) ? scored : 0,
      dblpMissing: Number.isFinite(dblpMissing) ? dblpMissing : 0,
      ambiguous: Number.isFinite(ambiguous) ? ambiguous : 0,
      rankNotFound: Number.isFinite(rankNotFound) ? rankNotFound : 0,
      excludedType: Number.isFinite(excludedType) ? excludedType : 0,
      missingAuthorCount: Number.isFinite(missingAuthorCount) ? missingAuthorCount : 0,
      lookupUnavailable: Number.isFinite(lookupUnavailable) ? lookupUnavailable : 0,
    };
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
      ...clean,
      completeness: clean.total > 0 ? clean.scored / clean.total : 0,
      formula: input.formula ?? "N_scored / N_total",
      segments: segmentDefinitions.map(([key, label]) => ({
        key,
        label,
        count: clean[key],
        ratio: clean.total > 0 ? clean[key] / clean.total : 0,
      })),
    };
  }

  function buildPublicationDecision(raw = {}) {
    const input = asObject(raw);
    const scholar = asObject(input.scholar);
    const dblp = asObject(input.dblp);
    const match = asObject(input.match);
    const classification = asObject(input.classification);
    const ranking = asObject(input.ranking);
    const score = asObject(input.score);

    return {
      schemaVersion: PUBLICATION_DECISION_SCHEMA_VERSION,
      scholar: {
        title: scholar.title ?? input.paperTitle ?? input.title ?? null,
        year: scholar.year ?? input.publicationYear ?? input.year ?? null,
        url: scholar.url ?? input.url ?? null,
        venueText: scholar.venueText ?? input.scholarVenue ?? null,
        authorsText: scholar.authorsText ?? input.authorsText ?? null,
      },
      dblp: {
        status: dblp.status ?? input.dblpStatus ?? null,
        pid: dblp.pid ?? input.dblpPid ?? null,
        key: dblp.key ?? input.dblpKey ?? null,
        title: dblp.title ?? input.dblpTitle ?? null,
        year: dblp.year ?? input.dblpYear ?? null,
        venue: dblp.venue ?? input.dblpVenue ?? null,
        venueFull: dblp.venueFull ?? input.dblpVenueFull ?? null,
        type: dblp.type ?? input.dblpType ?? null,
        pages: dblp.pages ?? input.pages ?? null,
        authorCount: dblp.authorCount ?? input.authorCount ?? null,
        authors: cloneArray(dblp.authors),
      },
      match: {
        status: match.status ?? input.decisionStatus ?? null,
        rawSimilarity: match.rawSimilarity ?? input.rawSimilarity ?? null,
        candidateGap: match.candidateGap ?? input.candidateGap ?? null,
        topCandidates: cloneArray(match.topCandidates).length ? cloneArray(match.topCandidates) : cloneArray(input.topCandidates),
        evidence: cloneArray(match.evidence).length ? cloneArray(match.evidence) : cloneArray(input.decisionEvidence),
      },
      evidence: {
        matchProbability: match.probability ?? input.matchProbability ?? input.matchConfidence ?? input.confidence ?? null,
        venueMatchConfidence: ranking.confidence ?? input.venueMatchConfidence ?? input.confidence ?? null,
      },
      classification: {
        publicationType: classification.publicationType ?? input.publicationType ?? score.publicationType ?? null,
        scoreEligibleByType: classification.scoreEligibleByType ?? classification.eligible ?? null,
        typeExclusionReason: classification.typeExclusionReason ?? classification.exclusionReason ?? null,
        signals: cloneArray(classification.signals),
      },
      ranking: {
        source: ranking.source ?? score.rankSource ?? input.system ?? null,
        rank: ranking.rank ?? score.rank ?? input.rank ?? null,
        rankingSnapshotYear: ranking.rankingSnapshotYear ?? ranking.snapshotYear ?? score.rankingSnapshotYear ?? input.rankingSnapshotYear ?? input.sourceYear ?? null,
        matchedVenue: ranking.matchedVenue ?? input.matchedVenue ?? null,
        confidence: ranking.confidence ?? input.venueMatchConfidence ?? input.confidence ?? null,
      },
      score: {
        eligible: score.eligible ?? input.eligible ?? false,
        venueValue: score.venueValue ?? input.venueValue ?? null,
        authorCount: score.authorCount ?? input.authorCount ?? null,
        fractionalCredit: score.fractionalCredit ?? input.fractionalCredit ?? null,
        contribution: score.contribution ?? input.contribution ?? input.scoreContribution ?? 0,
        rankSource: score.rankSource ?? ranking.source ?? input.system ?? null,
        rank: score.rank ?? ranking.rank ?? input.rank ?? null,
        rankingSnapshotYear: score.rankingSnapshotYear ?? ranking.rankingSnapshotYear ?? input.rankingSnapshotYear ?? input.sourceYear ?? null,
        exclusionReason: score.exclusionReason ?? input.exclusionReason ?? null,
      },
    };
  }

  function buildProfileReport(raw = {}) {
    const input = asObject(raw);
    const scores = asObject(input.scores);
    const diagnostics = asObject(input.diagnostics);
    const completeness = normalizeCompleteness(input.completeness, diagnostics, scores);
    const scoringPolicy = asObject(input.scoringPolicy);
    const policy = Object.keys(scoringPolicy).length ? scoringPolicy : scoreConfig.getScoringPolicy();

    return {
      schemaVersion: PROFILE_REPORT_SCHEMA_VERSION,
      scoreModelVersion: input.scoreModelVersion ?? scoreConfig.SCORE_MODEL_VERSION,
      decisionVersion: input.decisionVersion ?? null,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      scholarProfile: {
        userId: input.scholarProfile?.userId ?? null,
        name: input.scholarProfile?.name ?? null,
        url: input.scholarProfile?.url ?? null,
      },
      dblpProfile: {
        pid: input.dblpProfile?.pid ?? null,
        name: input.dblpProfile?.name ?? null,
        confidence: input.dblpProfile?.confidence ?? null,
      },
      settings: {
        scoringMode: "fractional_venue_score",
        authorshipModel: "fractional_counting",
        publicationTypePolicy: input.settings?.publicationTypePolicy ?? "full_papers_only",
        rankingPacks: Array.isArray(input.settings?.rankingPacks) ? input.settings.rankingPacks.slice() : ["core", "sjr"],
      },
      scoringPolicy: {
        formula: policy.formula ?? "sum(venueValue / authorCount)",
        authorship: "fractional",
        eligiblePublicationTypes: Array.isArray(policy.eligiblePublicationTypes) ? policy.eligiblePublicationTypes.slice() : ["full_conference", "full_journal"],
        venueValues: asObject(policy.venueValues),
        fractionalCountingOnly: true,
      },
      scores: {
        gsvrScore: scores.gsvrScore ?? input.gsvrScore ?? 0,
        coreContribution: scores.coreContribution ?? input.coreContribution ?? 0,
        sjrContribution: scores.sjrContribution ?? input.sjrContribution ?? 0,
        eligibleRankedPublications: scores.eligibleRankedPublications ?? input.eligibleRankedPublications ?? 0,
        fractionalPublicationWeight: scores.fractionalPublicationWeight ?? input.fractionalPublicationWeight ?? 0,
        averageVenueValue: scores.averageVenueValue ?? input.averageVenueValue ?? 0,
        sensitivity: scores.sensitivity ?? null,
      },
      diagnostics: {
        totalScholarItems: diagnostics.totalScholarItems ?? input.summary?.totalScholarItems ?? input.summary?.totalPublications ?? 0,
        eligibleRankedPublications: diagnostics.eligibleRankedPublications ?? scores.eligibleRankedPublications ?? 0,
        excludedShortPapers: diagnostics.excludedShortPapers ?? 0,
        excludedWorkshops: diagnostics.excludedWorkshops ?? 0,
        excludedDemosPosters: diagnostics.excludedDemosPosters ?? 0,
        excludedExtendedAbstracts: diagnostics.excludedExtendedAbstracts ?? 0,
        excludedPreprints: diagnostics.excludedPreprints ?? 0,
        dblpMissing: diagnostics.dblpMissing ?? diagnostics.missingDblp ?? 0,
        ambiguousMatches: diagnostics.ambiguousMatches ?? diagnostics.ambiguous ?? 0,
        unrankedVenues: diagnostics.unrankedVenues ?? diagnostics.sourceMissing ?? 0,
        missingAuthorCount: diagnostics.missingAuthorCount ?? 0,
        sourceRateLimited: diagnostics.sourceRateLimited ?? 0,
        sourceUnavailable: diagnostics.sourceUnavailable ?? 0,
        excludedPublications: diagnostics.excludedPublications ?? diagnostics.excluded ?? 0,
        notScored: diagnostics.notScored ?? 0,
        byReasonCode: asObject(diagnostics.byReasonCode),
      },
      completeness,
      metadata: asObject(input.metadata),
      publications: Array.isArray(input.publications)
        ? input.publications.map(buildPublicationDecision)
        : [],
    };
  }

  function validatePublicationDecision(value) {
    return !!value
      && value.schemaVersion === PUBLICATION_DECISION_SCHEMA_VERSION
      && !!value.scholar
      && !!value.dblp
      && !!value.match
      && !!value.evidence
      && !!value.classification
      && !!value.ranking
      && !!value.score;
  }

  function validateProfileReport(value) {
    return !!value
      && value.schemaVersion === PROFILE_REPORT_SCHEMA_VERSION
      && !!value.scholarProfile
      && !!value.dblpProfile
      && !!value.settings
      && !!value.scoringPolicy
      && !!value.scores
      && !!value.diagnostics
      && !!value.completeness
      && !!value.metadata
      && Array.isArray(value.publications)
      && value.publications.every(validatePublicationDecision);
  }

  return {
    PUBLICATION_DECISION_SCHEMA_VERSION,
    PROFILE_REPORT_SCHEMA_VERSION,
    buildPublicationDecision,
    buildProfileReport,
    validatePublicationDecision,
    validateProfileReport,
  };
});
