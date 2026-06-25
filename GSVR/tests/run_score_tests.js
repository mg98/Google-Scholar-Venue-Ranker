const assert = require('assert');

const scoreConfig = require('../core/score_config.js');
const publicationType = require('../core/publication_type.js');
const authorship = require('../core/authorship.js');
const temporal = require('../core/temporal_alignment.js');
const coverage = require('../core/coverage.js');
const scoreModel = require('../core/score_model.js');
const sensitivity = require('../core/score_sensitivity.js');
const reportSchema = require('../core/report_schema.js');

function closeTo(actual, expected, epsilon = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `Expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function scoredDecision(overrides = {}) {
  return {
    paperTitle: 'Scored publication',
    publicationYear: 2025,
    publicationType: 'full_conference',
    match: { status: 'verified' },
    dblp: { key: 'conf/example/One25', authorCount: 1 },
    ranking: { source: 'CORE', rank: 'A*', snapshotYear: 2023 },
    ...overrides,
  };
}

function testVenueValueMap() {
  assert.strictEqual(scoreConfig.SCORE_MODEL_VERSION, 'gsvr-fractional-venue-v1');
  assert.strictEqual(scoreModel.getVenueValue('CORE', 'A*'), 1);
  assert.strictEqual(scoreModel.getVenueValue('CORE', 'A'), 0.75);
  assert.strictEqual(scoreModel.getVenueValue('CORE', 'B'), 0.5);
  assert.strictEqual(scoreModel.getVenueValue('CORE', 'C'), 0.25);
  assert.strictEqual(scoreModel.getVenueValue('SJR', 'Q1'), 0.75);
  assert.strictEqual(scoreModel.getVenueValue('SJR', 'Q4'), 0.1);
  assert.strictEqual(scoreModel.getVenueValue('CORE', 'N/A'), null);
}

function testPublicationContributions() {
  closeTo(scoreModel.computePublicationContribution(scoredDecision()).contribution, 1.00);
  closeTo(scoreModel.computePublicationContribution(scoredDecision({
    dblp: { key: 'conf/example/Four25', authorCount: 4 },
  })).contribution, 0.25);
  closeTo(scoreModel.computePublicationContribution(scoredDecision({
    dblp: { key: 'conf/example/Two25', authorCount: 2 },
    ranking: { source: 'CORE', rank: 'A', snapshotYear: 2023 },
  })).contribution, 0.375);
  closeTo(scoreModel.computePublicationContribution(scoredDecision({
    publicationType: 'full_journal',
    dblp: { key: 'journals/example/Three25', authorCount: 3 },
    ranking: { source: 'SJR', rank: 'Q1', snapshotYear: 2024 },
  })).contribution, 0.25);
  closeTo(scoreModel.computePublicationContribution(scoredDecision({
    publicationType: 'full_journal',
    dblp: { key: 'journals/example/Ten25', authorCount: 10 },
    ranking: { source: 'SJR', rank: 'Q4', snapshotYear: 2024 },
  })).contribution, 0.01);
}

function testExclusions() {
  const excludedTypes = [
    'short_paper',
    'workshop',
    'demo',
    'poster',
    'extended_abstract',
    'preprint',
    'book_chapter',
    'unknown',
  ];

  for (const publicationTypeName of excludedTypes) {
    const score = scoreModel.computePublicationContribution(scoredDecision({ publicationType: publicationTypeName }));
    assert.strictEqual(score.eligible, false);
    assert.strictEqual(score.contribution, 0);
    assert.strictEqual(score.exclusionReason, publicationTypeName);
  }

  const missing = scoreModel.computePublicationContribution(scoredDecision({ match: { status: 'missing' } }));
  assert.strictEqual(missing.eligible, false);
  assert.strictEqual(missing.exclusionReason, 'dblp_missing');

  const ambiguous = scoreModel.computePublicationContribution(scoredDecision({ match: { status: 'ambiguous' } }));
  assert.strictEqual(ambiguous.eligible, false);
  assert.strictEqual(ambiguous.exclusionReason, 'ambiguous_match');

  const rateLimited = scoreModel.computePublicationContribution(scoredDecision({ match: { status: 'rate_limited' } }));
  assert.strictEqual(rateLimited.eligible, false);
  assert.strictEqual(rateLimited.exclusionReason, 'source_rate_limited');

  const failed = scoreModel.computePublicationContribution(scoredDecision({ match: { status: 'failed' } }));
  assert.strictEqual(failed.eligible, false);
  assert.strictEqual(failed.exclusionReason, 'source_unavailable');

  const unranked = scoreModel.computePublicationContribution(scoredDecision({ ranking: { source: 'CORE', rank: 'N/A', snapshotYear: 2023 } }));
  assert.strictEqual(unranked.eligible, false);
  assert.strictEqual(unranked.exclusionReason, 'rank_not_found');

  const missingAuthorCount = scoreModel.computePublicationContribution(scoredDecision({ dblp: { key: 'conf/example/Missing25' } }));
  assert.strictEqual(missingAuthorCount.eligible, false);
  assert.strictEqual(missingAuthorCount.exclusionReason, 'missing_author_count');

  const invalidAuthorCount = scoreModel.computePublicationContribution(scoredDecision({ dblp: { key: 'conf/example/Invalid25', authorCount: 0 } }));
  assert.strictEqual(invalidAuthorCount.eligible, false);
  assert.strictEqual(invalidAuthorCount.exclusionReason, 'missing_author_count');
}

function testPublicationTypeClassifier() {
  const shortPaper = publicationType.classifyPublicationType({
    system: 'CORE',
    rank: 'A',
    decisionEvidence: ['short_by_pages'],
  }, scoreConfig.DEFAULT_SCORE_CONFIG);

  assert.strictEqual(shortPaper.publicationType, 'short_paper');
  assert.strictEqual(shortPaper.scoreEligibleByType, false);
  assert.strictEqual(shortPaper.typeExclusionReason, 'short_paper');
  assert.ok(!Object.prototype.hasOwnProperty.call(shortPaper, 'typeFactor'));

  const corrSubstring = publicationType.classifyPublicationType({
    system: 'CORE',
    rank: 'A',
    title: 'Correctness proofs for wireless systems',
    dblp: { type: 'inproceedings', key: 'conf/example/Correct25' },
  });
  assert.strictEqual(corrSubstring.publicationType, 'full_conference');

  const corrPreprint = publicationType.classifyPublicationType({
    title: 'A preprint from CoRR',
    dblp: { key: 'journals/corr/abs-2501-12345' },
  });
  assert.strictEqual(corrPreprint.publicationType, 'preprint');
}

function testAuthorship() {
  assert.strictEqual(authorship.getFractionalCredit(4), 0.25);
  assert.strictEqual(authorship.getFractionalCredit(0), null);
  assert.strictEqual(authorship.getFractionalCredit(null), null);
  assert.strictEqual(authorship.getAuthorshipFactor(10), 0.1);

  const orderedAuthors = [
    { name: 'First Author', pid: '10/first' },
    { name: 'Middle Author', pid: '20/middle' },
    { name: 'Last Author', pid: '30/last' },
  ];

  const first = authorship.classifyAuthorPosition({ profilePid: '10/first', authors: orderedAuthors });
  assert.strictEqual(first.status, 'verified');
  assert.deepStrictEqual(first.roles, ['first']);
  assert.strictEqual(first.position, 1);
  assert.strictEqual(first.authorCount, 3);
  assert.strictEqual(first.source, 'dblp-author-order');

  const middle = authorship.classifyAuthorPosition({ profilePid: '20/middle', authors: orderedAuthors });
  assert.strictEqual(middle.status, 'verified');
  assert.deepStrictEqual(middle.roles, []);
  assert.strictEqual(middle.reason, 'middle_author');

  const last = authorship.classifyAuthorPosition({ profilePid: '30/last', authors: orderedAuthors });
  assert.strictEqual(last.status, 'verified');
  assert.deepStrictEqual(last.roles, ['last']);
  assert.strictEqual(last.position, 3);

  const single = authorship.classifyAuthorPosition({
    profilePid: '40/solo',
    authors: [{ name: 'Solo Author', pid: '40/solo' }],
  });
  assert.strictEqual(single.status, 'verified');
  assert.deepStrictEqual(single.roles, []);
  assert.strictEqual(single.position, 1);
  assert.strictEqual(single.authorCount, 1);
  assert.strictEqual(single.reason, 'single_author');

  const missing = authorship.classifyAuthorPosition({ profilePid: '99/missing', authors: orderedAuthors });
  assert.strictEqual(missing.status, 'unknown');
  assert.deepStrictEqual(missing.roles, []);
  assert.strictEqual(missing.reason, 'profile_pid_not_found');

  const duplicate = authorship.classifyAuthorPosition({
    profilePid: '10/first',
    authors: orderedAuthors.concat({ name: 'Duplicate Author', pid: '10/first' }),
  });
  assert.strictEqual(duplicate.status, 'unknown');
  assert.deepStrictEqual(duplicate.roles, []);
  assert.strictEqual(duplicate.reason, 'duplicate_profile_pid');

  const empty = authorship.classifyAuthorPosition({ profilePid: '10/first', authors: [] });
  assert.strictEqual(empty.status, 'unknown');
  assert.deepStrictEqual(empty.roles, []);
  assert.strictEqual(empty.reason, 'empty_author_list');

  const normalizedUnknown = authorship.normalizeAuthorship({ status: 'unknown', roles: ['first', 'last'] });
  assert.deepStrictEqual(normalizedUnknown.roles, []);

  const normalizedSingle = authorship.normalizeAuthorship({
    status: 'verified',
    roles: ['first', 'last'],
    position: 1,
    authorCount: 1,
  });
  assert.deepStrictEqual(normalizedSingle.roles, []);
  assert.strictEqual(normalizedSingle.reason, 'single_author');
}

function testSnapshotSelection() {
  assert.deepStrictEqual(
    temporal.selectRankingSnapshot(2024, [2018, 2021, 2023], 'CORE'),
    { snapshotYear: 2023, snapshotLabel: 'CORE 2023', limitedHistoricalCoverage: false }
  );
  assert.deepStrictEqual(
    temporal.selectRankingSnapshot(2025, [2018, 2021, 2023], 'CORE'),
    { snapshotYear: 2023, snapshotLabel: 'CORE 2023', limitedHistoricalCoverage: false }
  );
  assert.deepStrictEqual(
    temporal.selectRankingSnapshot(2026, [2018, 2021, 2023, 2026], 'CORE'),
    { snapshotYear: 2026, snapshotLabel: 'CORE 2026', limitedHistoricalCoverage: false }
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(temporal, 'getTemporalFactor'));
}

function testProfileScoreTotals() {
  const publications = [
    scoredDecision({
      paperTitle: 'CORE A* solo',
      dblp: { key: 'conf/example/Solo25', authorCount: 1 },
      ranking: { source: 'CORE', rank: 'A*', snapshotYear: 2023 },
    }),
    scoredDecision({
      paperTitle: 'CORE A double',
      dblp: { key: 'conf/example/Double25', authorCount: 2 },
      ranking: { source: 'CORE', rank: 'A', snapshotYear: 2023 },
    }),
    scoredDecision({
      paperTitle: 'SJR Q1 triple',
      publicationType: 'full_journal',
      dblp: { key: 'journals/example/Triple25', authorCount: 3 },
      ranking: { source: 'SJR', rank: 'Q1', snapshotYear: 2024 },
    }),
    scoredDecision({
      paperTitle: 'Short paper',
      publicationType: 'short_paper',
      dblp: { key: 'conf/example/Short25', authorCount: 2 },
      ranking: { source: 'CORE', rank: 'A*', snapshotYear: 2023 },
    }),
  ];
  const result = scoreModel.computeProfileScore(publications, scoreConfig.DEFAULT_SCORE_CONFIG);

  closeTo(result.scores.gsvrScore, 1 + 0.375 + 0.25);
  closeTo(result.scores.coreContribution, 1 + 0.375);
  closeTo(result.scores.sjrContribution, 0.25);
  closeTo(result.scores.fractionalPublicationWeight, 1 + 0.5 + (1 / 3));
  assert.strictEqual(result.scores.eligibleRankedPublications, 3);
  closeTo(result.scores.averageVenueValue, result.scores.gsvrScore / result.scores.fractionalPublicationWeight);
  assert.strictEqual(result.diagnostics.excludedShortPapers, 1);
  assert.strictEqual(result.completeness.total, 4);
  assert.strictEqual(result.completeness.scored, 3);
  assert.strictEqual(result.completeness.excludedType, 1);
  closeTo(result.completeness.completeness, 0.75);
}

function testCompletenessSummary() {
  const publications = [
    scoredDecision(),
    scoredDecision({ match: { status: 'missing' } }),
    scoredDecision({ match: { status: 'ambiguous' } }),
    scoredDecision({ ranking: { source: 'CORE', rank: 'N/A', snapshotYear: 2023 } }),
    scoredDecision({ publicationType: 'workshop' }),
    scoredDecision({ dblp: { key: 'conf/example/MissingAuthors25' } }),
    scoredDecision({ match: { status: 'rate_limited' } }),
  ];
  const result = scoreModel.computeCompleteness(publications, scoreConfig.DEFAULT_SCORE_CONFIG);

  assert.strictEqual(result.total, 7);
  assert.strictEqual(result.scored, 1);
  assert.strictEqual(result.dblpMissing, 1);
  assert.strictEqual(result.ambiguous, 1);
  assert.strictEqual(result.rankNotFound, 1);
  assert.strictEqual(result.excludedType, 1);
  assert.strictEqual(result.missingAuthorCount, 1);
  assert.strictEqual(result.lookupUnavailable, 1);
  closeTo(result.completeness, 1 / 7);
  assert.strictEqual(result.segments.reduce((total, segment) => total + segment.count, 0), 7);
}

function testCoverageSummary() {
  const publications = [
    scoredDecision(),
    scoredDecision({ publicationType: 'workshop' }),
    scoredDecision({ match: { status: 'missing' } }),
    scoredDecision({ ranking: { source: 'CORE', rank: 'N/A', snapshotYear: 2023 } }),
  ];
  const scored = publications.map((publication) => scoreModel.computePublicationScore(publication));
  const summary = coverage.summarizeCoverage(publications, scored);

  assert.strictEqual(summary.totalScholarItems, 4);
  assert.strictEqual(summary.eligibleRankedPublications, 1);
  assert.strictEqual(summary.excludedWorkshops, 1);
  assert.strictEqual(summary.dblpMissing, 1);
  assert.strictEqual(summary.unrankedVenues, 1);
}

function testSensitivityVariants() {
  const publications = [
    scoredDecision({
      publicationType: 'workshop',
      dblp: { key: 'conf/example/Workshop25', authorCount: 4 },
      ranking: { source: 'CORE', rank: 'A', snapshotYear: 2023 },
    }),
  ];
  const result = sensitivity.runSensitivity(publications, scoreConfig.DEFAULT_SCORE_CONFIG, ['include_workshops', 'core_only']);

  assert.strictEqual(result.primary.scores.gsvrScore, 0);
  assert.strictEqual(result.variants.length, 2);
  assert.ok(result.variants.find((variant) => variant.name === 'include_workshops').score.scores.gsvrScore > 0);
  assert.ok(Number.isFinite(result.stability.mean));
}

function testReportSchemaValidation() {
  const publicationScore = scoreModel.computePublicationScore(scoredDecision({
    dblp: { key: 'conf/example/Report25', authorCount: 3 },
    ranking: { source: 'CORE', rank: 'A', snapshotYear: 2023 },
  }));
  const publication = reportSchema.buildPublicationDecision({
    scholar: { title: 'Paper', year: 2025, url: 'https://example.test' },
    dblp: { key: 'conf/example/Report25', authorCount: 3 },
    match: { status: 'verified' },
    classification: publicationScore.classification,
    ranking: publicationScore.ranking,
    score: publicationScore.score,
  });
  assert.strictEqual(reportSchema.validatePublicationDecision(publication), true);
  assert.strictEqual(publication.schemaVersion, 'gsvr-publication-decision-v3');
  assert.deepStrictEqual(publication.authorship, {
    status: 'unknown',
    roles: [],
    position: null,
    authorCount: null,
    profilePid: null,
    source: 'dblp-author-order',
    reason: null,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(publication.score, 'temporalFactor'));
  assert.ok(!Object.prototype.hasOwnProperty.call(publication.score, 'coverageFactor'));
  assert.ok(!Object.prototype.hasOwnProperty.call(publication.score, 'contributionSd'));

  const report = reportSchema.buildProfileReport({
    scoreModelVersion: scoreConfig.SCORE_MODEL_VERSION,
    decisionVersion: 2,
    scholarProfile: { userId: 'abc', name: 'Example', url: 'https://scholar.google.com/citations?user=abc' },
    dblpProfile: { pid: '12/3456', name: 'Example', confidence: 1 },
    scoringPolicy: scoreConfig.getScoringPolicy(),
    scores: {
      gsvrScore: 0.25,
      coreContribution: 0.25,
      sjrContribution: 0,
      eligibleRankedPublications: 1,
      fractionalPublicationWeight: 1 / 3,
      averageVenueValue: 0.75,
    },
    completeness: {
      total: 1,
      scored: 1,
      dblpMissing: 0,
      ambiguous: 0,
      rankNotFound: 0,
      excludedType: 0,
      missingAuthorCount: 0,
      lookupUnavailable: 0,
    },
    diagnostics: { totalScholarItems: 1, eligibleRankedPublications: 1 },
    metadata: { rateLimitEvents: [] },
    publications: [publication],
  });

  assert.strictEqual(reportSchema.validateProfileReport(report), true);
  assert.strictEqual(report.schemaVersion, 'gsvr-profile-report-v3');
  assert.strictEqual(report.scores.gsvrScore, 0.25);
  assert.strictEqual(report.completeness.completeness, 1);
  assert.strictEqual(report.completeness.segments.length, 7);
  assert.strictEqual(report.scoringPolicy.fractionalCountingOnly, true);
}

function runScoreTests() {
  testVenueValueMap();
  testPublicationContributions();
  testExclusions();
  testPublicationTypeClassifier();
  testAuthorship();
  testSnapshotSelection();
  testProfileScoreTotals();
  testCompletenessSummary();
  testCoverageSummary();
  testSensitivityVariants();
  testReportSchemaValidation();
}

if (require.main === module) {
  runScoreTests();
  console.log('Score tests passed.');
}

module.exports = { runScoreTests };
