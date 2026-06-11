const assert = require('assert');
const fs = require('fs');
const path = require('path');

const core = require('../rank_core.js');
const settings = require('../settings.js');
const timelineStats = require('../core/timeline_stats.js');
const accuracyLib = require('./accuracy_benchmark_lib.js');
const { runScoreTests } = require('./run_score_tests.js');
const { runDblpSchedulerTests } = require('./run_dblp_scheduler_tests.js');
const VALID_RANKS = ['A*', 'A', 'B', 'C'];

function parseBundledCoreFile(fileName) {
  const filePath = path.join(__dirname, '..', 'core', fileName);
  const jsonData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let titleKey = 'International Conference on Advanced Communications and Computation';
  let acronymKey = 'INFOCOMP';
  if (/2018|2017|2014/.test(fileName)) {
    titleKey = 'Information Retrieval Facility Conference';
    acronymKey = 'IRFC';
  }
  return jsonData.map((rawEntry) => {
    const entry = { title: '', acronym: '', rank: 'N/A', rawRank: null };
    if (typeof rawEntry[titleKey] === 'string') entry.title = rawEntry[titleKey];
    else if (typeof rawEntry.title === 'string') entry.title = rawEntry.title;
    else if (typeof rawEntry.Title === 'string') entry.title = rawEntry.Title;

    if (typeof rawEntry[acronymKey] === 'string') entry.acronym = rawEntry[acronymKey];
    else if (typeof rawEntry.acronym === 'string') entry.acronym = rawEntry.acronym;
    else if (typeof rawEntry.Acronym === 'string') entry.acronym = rawEntry.Acronym;

    let rawRank = null;
    if (typeof rawEntry.Unranked === 'string') rawRank = rawEntry.Unranked;
    else if (typeof rawEntry.rank === 'string') rawRank = rawEntry.rank;
    else if (typeof rawEntry.CORE_Rating === 'string') rawRank = rawEntry.CORE_Rating;
    else if (typeof rawEntry.Rating === 'string') rawRank = rawEntry.Rating;

    if (typeof rawRank === 'string') {
      const trimmed = rawRank.trim();
      let cleaned = null;
      if (VALID_RANKS.includes(trimmed.toUpperCase())) cleaned = trimmed.toUpperCase();
      else if (/\b(unranked|merged|journal|inactive|discontinued|ceased|not\s+ranked|removed|withdrawn|retired|suspended)\b/i.test(trimmed)) cleaned = trimmed;
      entry.rawRank = cleaned || null;
      const normalized = String(cleaned || '').toUpperCase();
      if (VALID_RANKS.includes(normalized)) entry.rank = normalized;
    }

    entry.title = String(entry.title || '').trim();
    entry.acronym = String(entry.acronym || '').trim();
    return (entry.title || entry.acronym) ? entry : null;
  }).filter(Boolean);
}

function resolveBundledCoreVenue(fileName, query) {
  const coreData = parseBundledCoreFile(fileName);
  const aliasIndex = core.createCoreAliasIndex(coreData);
  return core.resolveCoreVenue({
    venueKey: query,
    fullVenueTitle: query,
    coreData,
    aliasIndex,
  });
}

function testDeterministicDblpMatch() {
  // Two equally-good candidates; tie-break should be deterministic (dblpKey lexicographic).
  const pubs1 = [
    { dblpKey: 'conf/sensys/sensys2020', title: 'On Securing Persistent State in Intermittent Computing', year: '2020', venue: 'SenSys' },
    { dblpKey: 'conf/sensys/enssys2020', title: 'On Securing Persistent State in Intermittent Computing', year: '2020', venue: 'ENSsys@SenSys' },
  ];
  const pubs2 = pubs1.slice().reverse();

  const r1 = core.selectBestDblpMatch({
    scholarTitle: 'On Securing Persistent State in Intermittent Computing',
    scholarYear: 2020,
    dblpPublications: pubs1,
    similarityThreshold: core.RANKING_CONFIG.publicationSimilarityThreshold,
    maxYearDiff: core.RANKING_CONFIG.publicationMaxYearDiff,
  });

  const r2 = core.selectBestDblpMatch({
    scholarTitle: 'On Securing Persistent State in Intermittent Computing',
    scholarYear: 2020,
    dblpPublications: pubs2,
    similarityThreshold: core.RANKING_CONFIG.publicationSimilarityThreshold,
    maxYearDiff: core.RANKING_CONFIG.publicationMaxYearDiff,
  });

  assert(r1 && r2, 'Expected a match in both runs');
  assert.strictEqual(r1.dblpKey, r2.dblpKey, 'Match should not depend on input ordering');
  assert.strictEqual(r1.dblpKey, 'conf/sensys/enssys2020', 'Expected lexicographically smallest dblpKey in a tie');
}

function testAmbiguousDblpMatchAbstains() {
  const pubs = [
    { dblpKey: 'conf/foo/2024a', title: 'Energy Harvesting for Embedded Systems', year: '2024', venue: 'FOO' },
    { dblpKey: 'conf/foo/2024b', title: 'Energy Harvesting of Embedded Systems', year: '2024', venue: 'FOO' },
  ];

  const result = core.selectBestDblpMatchDetailed({
    scholarTitle: 'Energy Harvesting Embedded Systems',
    scholarYear: 2024,
    dblpPublications: pubs,
  });

  assert.strictEqual(result.status, core.DECISION_STATUS.AMBIGUOUS);
  assert.strictEqual(core.selectBestDblpMatch({
    scholarTitle: 'Energy Harvesting Embedded Systems',
    scholarYear: 2024,
    dblpPublications: pubs,
  }), null);
}

function testWorkshopClassification() {
  const info = core.classifyVenueTrack({
    title: 'On Securing Persistent State in Intermittent Computing',
    venue: 'ENSsys@SenSys',
    venue_full: 'Proceedings of the 4th International Workshop on Energy Harvesting Systems',
    acronym: 'ENSsys',
    dblpKey: 'conf/sensys/enssys2020',
    scholarVenue: null,
    pageCount: 7,
  });
  assert.strictEqual(info.isWorkshop, true);
  assert.strictEqual(info.reason, 'Workshop');
  assert.strictEqual(info.resolvedVenue.toLowerCase(), 'enssys');
}

function testDemoPosterClassification() {
  const info = core.classifyVenueTrack({
    title: "Ph.D. Forum Abstract: Back to the Future - Sustainable Transiently Powered Embedded Systems",
    venue: 'IPSN',
    venue_full: null,
    acronym: 'IPSN',
    dblpKey: 'conf/ipsn/ipsn2016',
    scholarVenue: null,
    pageCount: 2,
  });
  assert.strictEqual(info.isDemoPoster, true);
  assert.strictEqual(info.reason, 'Demo/Poster');
}

function testShortPaperByPages() {
  assert.strictEqual(core.getPageCountFromPagesString('123-128'), 6);
  assert.strictEqual(core.getPageCountFromPagesString('24:1-24:2'), 2);
  assert.strictEqual(core.getPageCountFromPagesString('43–62'), 20);

  const info = core.classifyVenueTrack({
    title: 'Some Title',
    venue: 'IPSN',
    venue_full: null,
    acronym: 'IPSN',
    dblpKey: 'conf/ipsn/ipsn2016',
    scholarVenue: null,
    pageCount: 5,
  });
  assert.strictEqual(info.isShortPaper, true);
  assert.strictEqual(info.reason, 'Short-paper');
}

function testVenueNormalization() {
  assert.strictEqual(core.normalizeVenueCandidate('MobiQuitous (2)'), 'mobiquitous');
  assert.strictEqual(core.normalizeVenueCandidate('MobiQuitous 2'), 'mobiquitous');
}

function testCoreAliasResolution() {
  const coreData = [
    { title: 'SIGMOD', acronym: 'SIGMOD', rank: 'A*' },
    { title: 'MobiCom', acronym: 'MOBICOM', rank: 'A*' },
  ];
  const aliasIndex = core.createCoreAliasIndex(coreData);

  const sigmod = core.resolveCoreVenue({
    venueKey: 'SIGMOD Conference',
    fullVenueTitle: 'Proceedings of the ACM SIGMOD Conference',
    coreData,
    aliasIndex,
  });
  assert.strictEqual(sigmod.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(sigmod.rank, 'A*');

  const mobicom = core.resolveCoreVenue({
    venueKey: 'mobicom',
    fullVenueTitle: 'Proceedings of the Annual International Conference on Mobile Computing and Networking',
    coreData,
    aliasIndex,
  });
  assert.strictEqual(mobicom.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(mobicom.rank, 'A*');
}

function testAmbiguousCoreAcronymAbstains() {
  const coreData = [
    { title: 'International Workshop on Smart Systems', acronym: 'IWS', rank: 'B' },
    { title: 'International Workshop on Secure Storage', acronym: 'IWS', rank: 'A' },
  ];
  const aliasIndex = core.createCoreAliasIndex(coreData);
  const result = core.resolveCoreVenue({
    venueKey: 'IWS',
    fullVenueTitle: null,
    coreData,
    aliasIndex,
  });
  assert.strictEqual(result.status, core.DECISION_STATUS.AMBIGUOUS);
}


function testDemoKeywordNotTrackWhenPagesHigh() {
  // "demonstration" as part of a normal title should NOT force Demo/Poster.
  const info = core.classifyVenueTrack({
    title: 'MotionMA: motion modelling and analysis by demonstration',
    venue: 'ICRA',
    venue_full: 'Proceedings of the IEEE International Conference on Robotics and Automation',
    acronym: 'ICRA',
    dblpKey: 'conf/icra/icra2021',
    scholarVenue: null,
    pageCount: 8,
  });
  assert.strictEqual(info.isDemoPoster, false);
  assert.strictEqual(info.reason, null);
}

function testDemoKeywordNotTrackEvenWithoutPages() {
  // Even if pages are missing, "demonstration" inside the title should not be treated as a track label.
  const info = core.classifyVenueTrack({
    title: 'MotionMA: motion modelling and analysis by demonstration',
    venue: 'ICRA',
    venue_full: 'Proceedings of the IEEE International Conference on Robotics and Automation',
    acronym: 'ICRA',
    dblpKey: 'conf/icra/icra2021',
    scholarVenue: null,
    pageCount: null,
  });
  assert.strictEqual(info.isDemoPoster, false);
  assert.strictEqual(info.reason, null);
}

function testExtendedAbstractClassification() {
  const info = core.classifyVenueTrack({
    title: 'Some CHI Paper Title',
    venue: 'CHI',
    venue_full: 'Extended Abstracts of the 2024 CHI Conference on Human Factors in Computing Systems',
    acronym: 'CHI',
    dblpKey: 'conf/chi/chi2024ea',
    scholarVenue: null,
    pageCount: 4,
  });
  assert.strictEqual(info.isExtendedAbstract, true);
  assert.strictEqual(info.reason, 'Extended Abstract');
}

function testLetterPrefixPagesParsing() {
  assert.strictEqual(core.getPageCountFromPagesString('S1-S8'), 8);
  assert.strictEqual(core.getPageCountFromPagesString('e125-e130'), 6);
  assert.strictEqual(core.getPageCountFromPagesString('A12-A18'), 7);
}

function testPlusNormalization() {
  const a = core.normalizeForMatch('LEAF + AIO: Edge-Assisted Energy-Aware Object Detection for Mobile Augmented Reality');
  const b = core.normalizeForMatch('LEAF+AIO Edge Assisted Energy Aware Object Detection for Mobile Augmented Reality');
  assert.strictEqual(a, b);
}

function testSettingsNormalization() {
  const normalized = settings.normalizeSettings({
    autoRun: false,
    compactMode: true,
    showUnranked: false,
    defaultHighlightMode: 'needs-review',
    showDebugDetails: false,
  });

  assert.deepStrictEqual(normalized, {
    autoRun: false,
    compactMode: true,
    showUnranked: false,
    defaultHighlightMode: 'needs-review',
    showDebugDetails: false,
  });

  const fallback = settings.normalizeSettings({ defaultHighlightMode: 'invalid-mode' });
  assert.strictEqual(fallback.defaultHighlightMode, settings.DEFAULT_SETTINGS.defaultHighlightMode);
  assert.ok(!Object.prototype.hasOwnProperty.call(normalized, 'scanMode'));
  assert.ok(!Object.prototype.hasOwnProperty.call(fallback, 'scanMode'));
}

function testRankingPackNormalization() {
  const normalized = settings.normalizeRankingPacks(['sjr', 'ccf', 'sjr', 'CORE', 'invalid']);
  assert.deepStrictEqual(normalized, ['core', 'sjr']);

  const fallback = settings.normalizeRankingPacks([]);
  assert.deepStrictEqual(fallback, ['core', 'sjr']);
}

function testFeatureStateNormalization() {
  const reportDraft = settings.normalizeFeatureState('reportDraft', { payload: { title: 'Example venue mismatch' } });
  assert.deepStrictEqual(reportDraft, {
    createdAt: null,
    payload: { title: 'Example venue mismatch' },
  });

  const rankingPacks = settings.normalizeFeatureState('enabledRankingPacks', ['sjr', 'era', 'invalid']);
  assert.deepStrictEqual(rankingPacks, ['core', 'sjr']);

  const freshness = settings.normalizeFeatureState('dataFreshnessState', {
    lastSeenVersion: '2.0.1',
    lastDataRefreshLabel: 'CORE 2026 / SJR 2024',
    generatedAt: '2026-04-26T00:00:00.000Z',
  });
  assert.deepStrictEqual(freshness, {
    lastSeenVersion: '2.0.1',
    lastDataRefreshLabel: 'CORE 2026 / SJR 2024',
    lastCoreDatasetYear: null,
    lastSjrDatasetYear: null,
    updatedAt: null,
    generatedAt: '2026-04-26T00:00:00.000Z',
  });
}

function testCacheMetadataHelpers() {
  const expected = settings.buildCacheMetadata({
    rankingDataVersion: 'core-2026__sjr-v2-2024',
    coreDataYear: 2026,
    sjrDataVersion: 2,
    decisionVersion: 2,
  });

  assert.strictEqual(settings.isCacheMetadataCurrent({ ...expected }, expected), true);
  assert.strictEqual(
    settings.isCacheMetadataCurrent({ ...expected, scoreModelVersion: 'older-model' }, expected),
    false
  );
  assert.strictEqual(
    settings.isCacheMetadataCurrent({ ...expected, decisionVersion: 1 }, expected),
    false
  );
}

function testGeneratedSjrIndex() {
  const indexPath = path.join(__dirname, '..', 'data', 'sjr-index.json');
  assert.ok(fs.existsSync(indexPath), 'Expected generated SJR index to exist');

  const payload = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.strictEqual(payload.version, 3);
  assert.strictEqual(payload.startYear, 1999);
  assert.strictEqual(payload.endYear, 2024);
  assert.ok(Array.isArray(payload.entries), 'Expected compact SJR entries array');
  assert.ok(payload.entries.length > 36000, 'Expected compact SJR index to contain the bundled journals');

  const tpami = payload.entries.find((entry) => entry.n === 'ieee transaction pattern analysi machine intelligence');
  assert.ok(tpami, 'Expected TPAMI normalized journal entry to exist');
  assert.strictEqual(tpami.q['1999'], 'Q1');
  assert.strictEqual(tpami.q['2024'], 'Q1');
  assert.ok(Array.isArray(tpami.i), 'Expected SJR entries to include ISSN metadata');

  // Identity model: one entry per SCImago sourceId; previously-merged distinct
  // journals must now be separate entries with their own quartile histories.
  const diabetes = payload.entries.filter((entry) => entry.n === 'diabete');
  const journalOfDiabetes = payload.entries.filter((entry) => entry.n === 'journal diabete');
  assert.strictEqual(diabetes.length, 1, 'Expected "Diabetes" to have its own entry');
  assert.strictEqual(journalOfDiabetes.length, 1, 'Expected "Journal of Diabetes" to have its own entry');
  assert.notStrictEqual(diabetes[0].s, journalOfDiabetes[0].s, 'Distinct journals must keep distinct sourceIds');
  assert.strictEqual(diabetes[0].q['2022'], 'Q1');
  assert.strictEqual(journalOfDiabetes[0].q['2022'], 'Q2', 'Journal of Diabetes must not inherit Q1 from Diabetes');
}

function testJournalIdentityModelRegression() {
  // End-to-end through the shared resolver: merged-key journals resolve to
  // their OWN quartiles, raw-title equality breaks stem ties, and truly
  // ambiguous title-only queries abstain.
  const journalOfDiabetes = accuracyLib.resolveJournalQuerySync('Journal of Diabetes', 2022, {});
  assert.strictEqual(journalOfDiabetes.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(journalOfDiabetes.quartile, 'Q2');
  assert.strictEqual(journalOfDiabetes.matchedTitle, 'Journal of Diabetes');

  const diabetes = accuracyLib.resolveJournalQuerySync('Diabetes', 2022, {});
  assert.strictEqual(diabetes.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(diabetes.quartile, 'Q1');

  // "Neuroscience" stem-ties with the distinct journal "Neurosciences"; the
  // exact raw title must break the tie and yield Neuroscience's own Q2.
  const neuroscience = accuracyLib.resolveJournalQuerySync('Neuroscience', 2022, {});
  assert.strictEqual(neuroscience.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(neuroscience.matchedTitle, 'Neuroscience');
  assert.strictEqual(neuroscience.quartile, 'Q2');

  const journalOfGenetics = accuracyLib.resolveJournalQuerySync('Journal of Genetics', 2022, {});
  assert.strictEqual(journalOfGenetics.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(journalOfGenetics.quartile, 'Q4', 'Journal of Genetics must not inherit Q1 from Genetics');
}

function testHistoricalCoreSnapshots() {
  // Pre-2014 papers must consult era-appropriate snapshots instead of CORE 2014.
  assert.strictEqual(accuracyLib.getCoreDataFileForYear(2013), 'core/CORE_2013.json');
  assert.strictEqual(accuracyLib.getCoreDataFileForYear(2012), 'core/CORE_2010.json');
  assert.strictEqual(accuracyLib.getCoreDataFileForYear(2010), 'core/CORE_2010.json');
  assert.strictEqual(accuracyLib.getCoreDataFileForYear(2009), 'core/CORE_2008.json');
  assert.strictEqual(accuracyLib.getCoreDataFileForYear(1998), 'core/CORE_2008.json');
  assert.strictEqual(accuracyLib.getCoreDataFileForYear(2015), 'core/CORE_2014.json');

  const sigcomm2013 = resolveBundledCoreVenue('CORE_2013.json', 'SIGCOMM');
  assert.strictEqual(sigcomm2013.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(sigcomm2013.rank, 'A*');

  // ERA 2010 has no A* tier; SIGCOMM is rank A there.
  const sigcomm2010 = resolveBundledCoreVenue('CORE_2010.json', 'SIGCOMM');
  assert.strictEqual(sigcomm2010.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(sigcomm2010.rank, 'A');

  const sigcomm2008 = resolveBundledCoreVenue('CORE_2008.json', 'SIGCOMM');
  assert.strictEqual(sigcomm2008.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(sigcomm2008.rank, 'A*');
}

function testTitleAtSignDoesNotMakeWorkshop() {
  // A paper TITLE containing "@" (or the word "workshop") must not classify a
  // main-track paper as a workshop; only venue metadata carries that signal.
  const mainTrack = core.classifyVenueTrack({
    title: 'Energy@home: Smart Metering for Residential Energy Disaggregation',
    venue: 'SenSys',
    venue_full: 'Proceedings of the ACM Conference on Embedded Networked Sensor Systems',
    acronym: 'SenSys',
    dblpKey: 'conf/sensys/energy2023',
    pageCount: 12,
    dblpType: 'inproceedings',
  });
  assert.strictEqual(mainTrack.isWorkshop, false, 'Title "@" must not flag workshop');

  const titleMentionsWorkshop = core.classifyVenueTrack({
    title: 'Lessons Learned from the Dagstuhl Workshop on Intermittent Computing',
    venue: 'CACM',
    venue_full: 'Communications of the ACM',
    dblpKey: 'journals/cacm/lessons2023',
    pageCount: 10,
    dblpType: 'article',
  });
  assert.strictEqual(titleMentionsWorkshop.isWorkshop, false, 'Title mentioning "workshop" must not flag workshop');

  const venueAtNotation = core.classifyVenueTrack({
    title: 'On Securing Persistent State in Intermittent Computing',
    venue: 'ENSsys@SenSys',
    venue_full: 'Proceedings of the 4th International Workshop on Energy Harvesting Systems',
    acronym: 'ENSsys',
    dblpKey: 'conf/sensys/enssys2020',
    dblpType: 'inproceedings',
  });
  assert.strictEqual(venueAtNotation.isWorkshop, true, 'Venue "X@Y" must still flag workshop');
}

function testTruncatedTitleMatching() {
  const longTitle = 'A Comprehensive Study of Energy Harvesting Architectures for Batteryless Intermittent Computing Systems';
  const pubs = [
    { dblpKey: 'conf/sensys/a1', title: longTitle, year: '2022', venue: 'SenSys' },
    { dblpKey: 'conf/sensys/b2', title: 'Some Other Paper About Different Things Entirely', year: '2022', venue: 'SenSys' },
  ];
  const truncated = `${longTitle.slice(0, 64).trim()}…`;
  const matchResult = core.selectBestDblpMatchDetailed({ scholarTitle: truncated, scholarYear: 2022, dblpPublications: pubs });
  assert.strictEqual(matchResult.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(matchResult.match.dblpKey, 'conf/sensys/a1');
  assert.strictEqual(matchResult.truncatedTitleMatch, true);

  // Two papers sharing the truncated prefix must abstain instead of guessing.
  const ambiguousPubs = [
    { dblpKey: 'conf/x/p1', title: 'A Longitudinal Study of Network Behavior in Campus Networks: Measurements', year: '2022', venue: 'X' },
    { dblpKey: 'conf/x/p2', title: 'A Longitudinal Study of Network Behavior in Campus Networks: Modeling', year: '2022', venue: 'X' },
  ];
  const ambiguousResult = core.selectBestDblpMatchDetailed({
    scholarTitle: 'A Longitudinal Study of Network Behavior in Campus Networks…',
    scholarYear: 2022,
    dblpPublications: ambiguousPubs,
  });
  assert.strictEqual(ambiguousResult.status, core.DECISION_STATUS.AMBIGUOUS);

  // A short truncated prefix carries too little signal and must abstain.
  const shortResult = core.selectBestDblpMatchDetailed({ scholarTitle: 'Short title…', scholarYear: 2022, dblpPublications: pubs });
  assert.strictEqual(shortResult.status, core.DECISION_STATUS.MISSING);
  assert.strictEqual(shortResult.reason, 'truncated_title_too_short');
}

function testAcronymTitleCrossCheck() {
  const coreData = [
    { title: 'Passive and Active Measurement Conference', acronym: 'PAM', rank: 'C' },
  ];
  const aliasIndex = core.createCoreAliasIndex(coreData);

  const mismatch = core.resolveCoreVenue({
    venueKey: 'PAM',
    fullVenueTitle: 'Pacific Asian Conference on Marketing Analytics',
    coreData,
    aliasIndex,
  });
  assert.strictEqual(mismatch.status, core.DECISION_STATUS.AMBIGUOUS, 'Unrelated full title must abstain');
  assert.strictEqual(mismatch.reason, 'acronym_title_mismatch');

  const legit = core.resolveCoreVenue({
    venueKey: 'PAM',
    fullVenueTitle: 'Proceedings of the Passive and Active Measurement Conference',
    coreData,
    aliasIndex,
  });
  assert.strictEqual(legit.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(legit.rank, 'C');

  const bareAcronym = core.resolveCoreVenue({ venueKey: 'PAM', fullVenueTitle: 'PAM', coreData, aliasIndex });
  assert.strictEqual(bareAcronym.status, core.DECISION_STATUS.MATCHED, 'Acronym-only queries must still match');
}

function testDiacriticFoldingInMatching() {
  assert.strictEqual(core.normalizeForMatch('Müller-Schloß Systems'), core.normalizeForMatch('Muller-Schloss Systems'));
  assert.strictEqual(core.normalizeProfileName('José García'), 'jose garcia');

  // An accented Scholar title must exact-match the unaccented DBLP rendering.
  const match = core.selectBestDblpMatch({
    scholarTitle: 'Énergie Harvesting für Müller Networks',
    scholarYear: 2021,
    dblpPublications: [
      { dblpKey: 'conf/test/fold1', title: 'Energie Harvesting fur Muller Networks', year: '2021', venue: 'TEST' },
    ],
  });
  assert.ok(match, 'Expected diacritic-folded exact title match');
  assert.strictEqual(match.dblpKey, 'conf/test/fold1');
}

function testTimelineFilteringAndCounts() {
  const publications = [
    { publicationYear: 2016, system: 'CORE', rank: 'A*' },
    { publicationYear: 2017, system: 'CORE', rank: 'A' },
    { publicationYear: 2024, system: 'SJR', rank: 'Q1' },
    { publicationYear: 2026, system: 'CORE', rank: 'C' },
    { publicationYear: 2027, system: 'CORE', rank: 'B' },
    { system: 'SJR', rank: 'Q2' },
  ];

  const full = timelineStats.buildTimelineStats(publications, {
    rangeMode: timelineStats.RANGE_FULL,
    currentYear: 2026,
  });
  assert.strictEqual(full.publications.length, publications.length);
  assert.strictEqual(full.coreRankCounts['A*'], 1);
  assert.strictEqual(full.coreRankCounts.A, 1);
  assert.strictEqual(full.coreRankCounts.B, 1);
  assert.strictEqual(full.coreRankCounts.C, 1);
  assert.strictEqual(full.sjrRankCounts.Q1, 1);
  assert.strictEqual(full.sjrRankCounts.Q2, 1);
  assert.strictEqual(full.allUnknownYearCount, 1);

  const recent = timelineStats.buildTimelineStats(publications, {
    rangeMode: timelineStats.RANGE_LAST_10_YEARS,
    currentYear: 2026,
  });
  assert.deepStrictEqual(
    recent.publications.map((item) => item.publicationYear ?? null),
    [2017, 2024, 2026]
  );
  assert.deepStrictEqual(recent.range, {
    mode: timelineStats.RANGE_LAST_10_YEARS,
    label: 'Last 10 Years',
    startYear: 2017,
    endYear: 2026,
  });
  assert.strictEqual(recent.coreRankCounts['A*'], 0);
  assert.strictEqual(recent.coreRankCounts.A, 1);
  assert.strictEqual(recent.coreRankCounts.C, 1);
  assert.strictEqual(recent.sjrRankCounts.Q1, 1);
  assert.strictEqual(recent.sjrRankCounts.Q2, 0);
  assert.strictEqual(recent.unknownYearCount, 0);
}

function testTimelineRankCountRecomputation() {
  const counts = timelineStats.recomputeRankCounts([
    { system: 'CORE', rank: 'A*' },
    { system: 'CORE', rank: 'unknown' },
    { system: 'SJR', rank: 'Q3' },
    { system: 'SJR', rank: 'Q9' },
    { system: 'DBLP', rank: 'A' },
  ]);

  assert.strictEqual(counts.coreRankCounts['A*'], 1);
  assert.strictEqual(counts.coreRankCounts['N/A'], 1);
  assert.strictEqual(counts.sjrRankCounts.Q3, 1);
  assert.strictEqual(counts.sjrRankCounts['N/A'], 1);
}

function testFixedWindowTimelineHistogram() {
  const histogram = timelineStats.buildFixedWindowHistogram([
    { publicationYear: 2018, system: 'CORE', rank: 'A*' },
    { publicationYear: 2019, system: 'CORE', rank: 'A*' },
    { publicationYear: 2020, system: 'SJR', rank: 'Q2' },
    { publicationYear: 2026, system: 'SJR', rank: 'Q4' },
    { publicationYear: null, system: 'CORE', rank: 'A' },
  ], {
    currentYear: 2026,
    years: 8,
  });

  assert.deepStrictEqual(histogram.map((bucket) => bucket.year), [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  assert.strictEqual(histogram[0].ranks['A*'], 1);
  assert.strictEqual(histogram[1].ranks.Q2, 1);
  assert.strictEqual(histogram[7].ranks.Q4, 1);
  assert.strictEqual(histogram.reduce((total, bucket) => total + bucket.total, 0), 3);
}

function testFullTimelineHistogramFillsKnownYearGaps() {
  const histogram = timelineStats.buildFullTimelineHistogram([
    { publicationYear: 2019, system: 'CORE', rank: 'B' },
    { publicationYear: 2021, system: 'SJR', rank: 'Q1' },
    { system: 'CORE', rank: 'A' },
  ]);

  assert.deepStrictEqual(histogram.map((bucket) => bucket.year), [2019, 2020, 2021]);
  assert.strictEqual(histogram[0].ranks.B, 1);
  assert.strictEqual(histogram[1].total, 0);
  assert.strictEqual(histogram[2].ranks.Q1, 1);
}

function testFocusedTimelineHistograms() {
  const histogram = timelineStats.buildYearlyHistogram([
    { publicationYear: 2019, system: 'CORE', rank: 'A*' },
    { publicationYear: 2019, system: 'CORE', rank: 'A' },
    { publicationYear: 2019, system: 'CORE', rank: 'B' },
    { publicationYear: 2019, system: 'SJR', rank: 'Q1' },
    { publicationYear: 2020, system: 'SJR', rank: 'Q1' },
    { publicationYear: 2020, system: 'SJR', rank: 'Q2' },
  ], {
    startYear: 2019,
    endYear: 2020,
  });

  const focused = timelineStats.buildFocusedHistograms(histogram);
  assert.deepStrictEqual(focused.topCoreHistogram.map((bucket) => bucket.year), [2019, 2020]);
  assert.strictEqual(focused.topCoreHistogram[0].ranks['A*'], 1);
  assert.strictEqual(focused.topCoreHistogram[0].ranks.A, 1);
  assert.strictEqual(focused.topCoreHistogram[0].ranks.B, undefined);
  assert.strictEqual(focused.topCoreHistogram[0].total, 2);
  assert.strictEqual(focused.topCoreHistogram[1].total, 0);
  assert.deepStrictEqual(focused.q1Histogram.map((bucket) => bucket.year), [2019, 2020]);
  assert.strictEqual(focused.q1Histogram[0].ranks.Q1, 1);
  assert.strictEqual(focused.q1Histogram[1].ranks.Q1, 1);
  assert.strictEqual(focused.q1Histogram[0].ranks.Q2, undefined);
}

function testTimelineStatsIncludesFocusedWindows() {
  const publications = [
    { publicationYear: 2016, system: 'CORE', rank: 'A*' },
    { publicationYear: 2017, system: 'CORE', rank: 'A' },
    { publicationYear: 2019, system: 'CORE', rank: 'A*' },
    { publicationYear: 2020, system: 'SJR', rank: 'Q1' },
    { publicationYear: 2026, system: 'SJR', rank: 'Q1' },
    { system: 'SJR', rank: 'Q1' },
  ];

  const stats = timelineStats.buildTimelineStats(publications, {
    rangeMode: timelineStats.RANGE_LAST_10_YEARS,
    currentYear: 2026,
    recentYears: 8,
  });

  assert.deepStrictEqual(stats.focusedHistograms.recent.topCoreHistogram.map((bucket) => bucket.year), [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  assert.strictEqual(stats.focusedHistograms.recent.topCoreHistogram.reduce((total, bucket) => total + bucket.total, 0), 1);
  assert.strictEqual(stats.focusedHistograms.recent.q1Histogram.reduce((total, bucket) => total + bucket.total, 0), 2);
  assert.strictEqual(stats.focusedHistograms.full.topCoreHistogram.reduce((total, bucket) => total + bucket.total, 0), 3);
  assert.strictEqual(stats.focusedHistograms.full.q1Histogram.reduce((total, bucket) => total + bucket.total, 0), 2);
}

function testSummaryDistributionRenderUsesFilteredCounts() {
  const contentPath = path.join(__dirname, '..', 'content.js');
  const source = fs.readFileSync(contentPath, 'utf8');
  assert.ok(
    source.includes('counts: currentSummaryState.coreRankCounts || createEmptyCoreRankCounts()'),
    'CORE distribution should render from the filtered currentSummaryState counts'
  );
  assert.ok(
    source.includes('counts: currentSummaryState.sjrRankCounts || createEmptySjrRankCounts()'),
    'SJR distribution should render from the filtered currentSummaryState counts'
  );
  assert.ok(
    source.includes("getTimelineFocusedHistograms(currentSummaryState.timeline, 'recent')"),
    'Sidebar should render focused recent histograms from currentSummaryState'
  );
}

function testReportTimelineChartsUseStackedHorizontalLayout() {
  const contentPath = path.join(__dirname, '..', 'content.js');
  const source = fs.readFileSync(contentPath, 'utf8');
  assert.ok(
    source.includes('function createPdfFocusedTimelineChartSvg'),
    'PDF reports should render focused timeline histograms as chart strips'
  );
  assert.ok(
    source.includes('transform="rotate(-90'),
    'Report year labels should be rotated to save horizontal space'
  );
  assert.ok(
    source.includes('grid-template-columns:repeat(${Math.max(1, buckets.length)},minmax(0,1fr))'),
    'HTML reports should fit all timeline years in a single chart row'
  );
  assert.ok(
    source.includes('.timeline-grid{display:grid;grid-template-columns:1fr;gap:18px}'),
    'HTML reports should stack the conference and journal charts vertically'
  );
  assert.ok(
    source.includes("createPdfFocusedTimelineChart('A*/A CORE Timeline'") &&
    source.includes("createPdfFocusedTimelineChart('Q1 Journal Timeline'"),
    'PDF reports should render conference chart before journal chart'
  );
  assert.ok(
    source.includes('unbreakable: true'),
    'PDF report chart titles, legends, and graphs should move across pages as one block'
  );
  assert.ok(
    source.includes('break-inside:avoid;page-break-inside:avoid'),
    'Standalone HTML report chart panels should avoid print/page breaks inside a chart'
  );
}

function testHistoricalSjrCoverageUnavailable() {
  const dataset = accuracyLib.loadSjrDataset();
  assert.strictEqual(dataset.startYear, 1999);

  const result = accuracyLib.resolveJournalQuerySync('IEEE Transactions on Pattern Analysis and Machine Intelligence', 1998, {});
  assert.strictEqual(result.status, core.DECISION_STATUS.UNRANKED);
  assert.strictEqual(result.quartile, 'N/A');
  assert.strictEqual(result.sourceYear, null);
  assert.strictEqual(result.sourceYearFallback, false);
  assert.strictEqual(result.reason, 'sjr_historical_coverage_unavailable');
}

function testProfileCandidateScoring() {
  const result = core.scoreDblpProfileCandidate({
    scholarName: 'Naveed Anwar Bhatti',
    candidateName: 'Naveed Anwar Bhatti',
    scholarSamplePubs: [
      { title: 'Energy Harvesting Systems for IoT', year: 2024 },
      { title: 'Reliable Intermittent Computing at the Edge', year: 2023 },
    ],
    dblpPublications: [
      { dblpKey: 'conf/test/1', title: 'Energy Harvesting Systems for IoT', year: '2024' },
      { dblpKey: 'conf/test/2', title: 'Reliable Intermittent Computing at the Edge', year: '2023' },
    ],
  });

  assert.strictEqual(result.status, core.DECISION_STATUS.MATCHED);
  assert.ok(result.score >= core.RANKING_CONFIG.profileMatchScoreThreshold);
}

function testManualDblpPidExtraction() {
  assert.strictEqual(settings.extractDblpPid('64/4311'), '64/4311');
  assert.strictEqual(
    settings.extractDblpPid('https://dblp.org/pid/64/4311.html'),
    '64/4311'
  );
  assert.strictEqual(
    settings.extractDblpPid(' pid/64/4311.html '),
    '64/4311'
  );
  assert.strictEqual(settings.extractDblpPid('https://example.com/pid/64/4311.html'), null);
  assert.strictEqual(settings.extractDblpPid('not-a-dblp-profile'), null);
}

function testProfileCacheReuseRequiresVerifiedPid() {
  assert.strictEqual(
    settings.shouldReuseProfileCacheEntry({
      publicationRanks: {
        'https://example.test/paper': { rank: 'A' },
      },
      dblpAuthorPid: '64/4311',
    }),
    true
  );
  assert.strictEqual(
    settings.shouldReuseProfileCacheEntry({
      publicationRanks: {
        'https://example.test/paper': { rank: 'A' },
      },
    }),
    false
  );
  assert.strictEqual(
    settings.shouldReuseProfileCacheEntry({
      publicationRanks: {},
    }),
    true
  );
  assert.strictEqual(settings.shouldReuseProfileCacheEntry(null), false);
}

function testDblpPidSelectionPrecedence() {
  const manualPreferred = settings.selectPreferredDblpPidCandidate([
    { pid: 'https://dblp.org/pid/64/4311.html', source: 'manual', tag: 'manual' },
    { pid: '12/3456', source: 'cached', tag: 'profile-cache' },
    { pid: '78/9000', source: 'search', tag: 'search' },
  ]);
  assert.deepStrictEqual(manualPreferred, {
    pid: '64/4311',
    source: 'manual',
    tag: 'manual',
  });

  const automaticFallback = settings.selectPreferredDblpPidCandidate([
    null,
    { pid: '', source: 'manual', tag: 'manual' },
    { pid: '12/3456', source: 'cached', tag: 'profile-cache' },
    { pid: '78/9000', source: 'search', tag: 'search' },
  ]);
  assert.deepStrictEqual(automaticFallback, {
    pid: '12/3456',
    source: 'cached',
    tag: 'profile-cache',
  });

  const searchFallback = settings.selectPreferredDblpPidCandidate([
    null,
    null,
    { pid: '78/9000', source: 'search', tag: 'search' },
  ]);
  assert.deepStrictEqual(searchFallback, {
    pid: '78/9000',
    source: 'search',
    tag: 'search',
  });
}

function testManualDblpUiSmoke() {
  const contentPath = path.join(__dirname, '..', 'content.js');
  const contentSource = fs.readFileSync(contentPath, 'utf8');

  assert.ok(contentSource.includes('Rescan Me'));
  assert.ok(contentSource.includes('Add My DBLP Profile'));
  assert.ok(contentSource.includes('Change DBLP'));
  assert.ok(contentSource.includes('Clear Manual DBLP'));
  assert.ok(contentSource.includes('Using manually selected DBLP profile'));
}

function testDblpPersonXmlScholarUrlParsing() {
  const xml = `<?xml version="1.0"?>
<dblpperson name="Wolfgang Stuerzlinger" pid="64/4311">
  <person key="homepages/64/4311">
    <author pid="64/4311">Wolfgang Stuerzlinger</author>
    <url>http://www.cse.yorku.ca/~wolfgang/</url>
    <url>https://scholar.google.com/citations?user=78KBaPsAAAAJ</url>
    <url>https://orcid.org/0000-0002-7110-5024</url>
  </person>
</dblpperson>`;

  const urls = settings.extractDblpPersonUrlsFromXml(xml);
  const scholarUrl = urls.find((url) => String(url).includes('scholar.google.com/citations'));

  assert.ok(Array.isArray(urls));
  assert.strictEqual(scholarUrl, 'https://scholar.google.com/citations?user=78KBaPsAAAAJ');
  assert.strictEqual(settings.extractScholarUserId(scholarUrl), '78KBaPsAAAAJ');
  assert.strictEqual(
    settings.normalizeScholarProfileUrl('https://scholar.google.co.uk/citations?user=78KBaPsAAAAJ&hl=en'),
    'https://scholar.google.com/citations?user=78KBaPsAAAAJ'
  );
  assert.strictEqual(settings.extractScholarUserId('https://orcid.org/0000-0002-7110-5024'), null);
}

function testScholarVerificationSampleBuilder() {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    title: `paper-${index}`,
    normalizedTitle: `paper-${index}`,
    year: 2000 + index,
  }));
  const sample = settings.buildScholarVerificationSample(rows, 6);

  assert.deepStrictEqual(
    sample.map((entry) => entry.title),
    ['paper-0', 'paper-4', 'paper-8', 'paper-11', 'paper-15', 'paper-19']
  );
  assert.strictEqual(sample[2].year, 2008);

  const deduped = settings.buildScholarVerificationSample([
    { title: 'paper-a', normalizedTitle: 'paper-a', year: 2020 },
    { title: 'paper-a duplicate', normalizedTitle: 'paper-a', year: 2021 },
    { title: 'paper-b', normalizedTitle: 'paper-b', year: 2022 },
  ], 3);
  assert.deepStrictEqual(
    deduped.map((entry) => entry.normalizedTitle),
    ['paper-a', 'paper-b']
  );
  assert.strictEqual(deduped[0].year, 2020);
}

function testProfileVerificationCandidateSelection() {
  const exactWinner = settings.selectBestProfileVerificationCandidate([
    {
      pid: '64/4311',
      matchReason: 'scholar_user',
      status: 'missing',
      score: 2.4,
      overlapCount: 0,
      matchedScholarUserId: '78KBaPsAAAAJ',
    },
    {
      pid: '12/3456',
      matchReason: 'publication_overlap',
      status: 'matched',
      score: 7.8,
      overlapCount: 4,
    },
  ], {
    profileStrongScoreThreshold: core.RANKING_CONFIG.profileStrongScoreThreshold,
    profileAmbiguityGap: core.RANKING_CONFIG.profileAmbiguityGap,
  });
  assert.strictEqual(exactWinner.pid, '64/4311');
  assert.strictEqual(exactWinner.matchedScholarUserId, '78KBaPsAAAAJ');

  const publicationWinner = settings.selectBestProfileVerificationCandidate([
    {
      pid: '12/3456',
      matchReason: 'publication_overlap',
      status: 'matched',
      score: 8.1,
      overlapCount: 4,
    },
    {
      pid: '98/7654',
      matchReason: 'publication_overlap',
      status: 'matched',
      score: 6.9,
      overlapCount: 3,
    },
  ], {
    profileStrongScoreThreshold: core.RANKING_CONFIG.profileStrongScoreThreshold,
    profileAmbiguityGap: core.RANKING_CONFIG.profileAmbiguityGap,
  });
  assert.strictEqual(publicationWinner.pid, '12/3456');

  const ambiguous = settings.selectBestProfileVerificationCandidate([
    {
      pid: '12/3456',
      matchReason: 'publication_overlap',
      status: 'matched',
      score: 4.0,
      overlapCount: 2,
    },
    {
      pid: '98/7654',
      matchReason: 'publication_overlap',
      status: 'matched',
      score: 3.8,
      overlapCount: 2,
    },
  ], {
    profileStrongScoreThreshold: core.RANKING_CONFIG.profileStrongScoreThreshold,
    profileAmbiguityGap: core.RANKING_CONFIG.profileAmbiguityGap,
  });
  assert.strictEqual(ambiguous, null);
}

function testProfileVerificationEscalationGate() {
  assert.strictEqual(settings.shouldEscalateProfileVerification('no_match'), true);
  assert.strictEqual(settings.shouldEscalateProfileVerification('ambiguous'), true);
  assert.strictEqual(settings.shouldEscalateProfileVerification('matched'), false);
  assert.strictEqual(settings.shouldEscalateProfileVerification('rate_limited'), false);
  assert.strictEqual(settings.shouldEscalateProfileVerification('unavailable'), false);
}

function testWolfgangScholarUserRegression() {
  const scholarUrl = 'https://scholar.google.com/citations?user=78KBaPsAAAAJ&hl=en';
  const normalizedScholarUrl = settings.normalizeScholarProfileUrl(scholarUrl);
  const selected = settings.selectBestProfileVerificationCandidate([
    {
      pid: '64/4311',
      matchReason: 'scholar_user',
      matchedScholarUserId: settings.extractScholarUserId(scholarUrl),
      profileUrls: [normalizedScholarUrl],
      status: 'missing',
      score: 2.4,
      overlapCount: 0,
    },
    {
      pid: '12/3456',
      matchReason: 'publication_overlap',
      status: 'matched',
      score: 6.7,
      overlapCount: 2,
    },
  ], {
    profileStrongScoreThreshold: core.RANKING_CONFIG.profileStrongScoreThreshold,
    profileAmbiguityGap: core.RANKING_CONFIG.profileAmbiguityGap,
  });

  assert.strictEqual(selected.pid, '64/4311');
  assert.strictEqual(selected.matchedScholarUserId, '78KBaPsAAAAJ');
}

function testPersistentDblpCacheKeyBuilders() {
  assert.strictEqual(
    settings.buildDblpStreamMetaCacheKey('conf', 'sensys'),
    'gsvr_dblp_stream_meta_v1_conf%3Asensys'
  );
  assert.strictEqual(
    settings.buildDblpCheapProfileCacheKey('https://dblp.org/pid/64/4311.html'),
    'gsvr_dblp_profile_check_v1_64%2F4311'
  );
  const authorSearchKey = settings.buildDblpAuthorSearchCacheKey('Wolfgang   Stuerzlinger');
  assert.ok(authorSearchKey.includes('wolfgang%20stuerzlinger'));
}

function testLocalVenueCandidateBuilder() {
  const candidates = settings.buildLocalVenueCandidateNames({
    rawVenue: 'Proc. ACM Program. Lang.',
    journal: 'Proc. ACM Program. Lang.',
    crossref: 'conf/popl/popl2024',
    dblpKey: 'journals/pacmpl/Smith24',
    number: 'POPL',
  });

  assert.ok(candidates.includes('Proc. ACM Program. Lang.'));
  assert.ok(candidates.includes('popl'));
  assert.ok(candidates.includes('pacmpl'));
  assert.strictEqual(candidates.filter((candidate) => candidate.toLowerCase() === 'popl').length, 1);
}

function testLocalFirstStreamReductionSourceSmoke() {
  const contentPath = path.join(__dirname, '..', 'content.js');
  const backgroundPath = path.join(__dirname, '..', 'background.js');
  const contentSource = fs.readFileSync(contentPath, 'utf8');
  const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

  assert.ok(contentSource.includes('resolveLocalVenueBeforeStreamLookup(entry, phase)'));
  assert.ok(contentSource.includes('buildDblpStreamMetaPersistentCacheKey'));
  assert.ok(contentSource.includes("loadPersistentDblpCacheEntry(cacheKey, getPersistentCacheTtlMs('cheap-profile'))"));
  assert.ok(backgroundSource.includes("failureKind: 'busy'"));
  assert.ok(backgroundSource.includes("importScripts('dblp/dblp_scheduler.js')"));
  assert.ok(backgroundSource.includes('DBLP_MAX_IN_FLIGHT = DBLP_REQUEST_POLICY.maxConcurrent || 1'));
  assert.ok(backgroundSource.includes('pendingRequestGroups'));
}

function testFixtureCorpusMetrics() {
  const fixtures = [
    {
      expected: core.DECISION_STATUS.MATCHED,
      result: core.resolveCoreVenue({
        venueKey: 'SIGMOD Conference',
        fullVenueTitle: 'Proceedings of the ACM SIGMOD Conference',
        coreData: [{ title: 'SIGMOD', acronym: 'SIGMOD', rank: 'A*' }],
      }),
    },
    {
      expected: core.DECISION_STATUS.AMBIGUOUS,
      result: core.resolveCoreVenue({
        venueKey: 'IWS',
        fullVenueTitle: null,
        coreData: [
          { title: 'International Workshop on Smart Systems', acronym: 'IWS', rank: 'B' },
          { title: 'International Workshop on Secure Storage', acronym: 'IWS', rank: 'A' },
        ],
      }),
    },
    {
      expected: core.DECISION_STATUS.MATCHED,
      result: core.selectBestDblpMatchDetailed({
        scholarTitle: 'Energy Harvesting Systems for IoT',
        scholarYear: 2024,
        dblpPublications: [{ dblpKey: 'conf/test/1', title: 'Energy Harvesting Systems for IoT', year: '2024' }],
      }),
    },
  ];

  let matched = 0;
  let correctMatches = 0;
  let abstained = 0;
  for (const fixture of fixtures) {
    const status = fixture.result.status;
    if (status === core.DECISION_STATUS.MATCHED) {
      matched++;
      if (fixture.expected === status) correctMatches++;
    } else if (status === core.DECISION_STATUS.AMBIGUOUS || status === core.DECISION_STATUS.MISSING) {
      abstained++;
    }
  }

  const precision = matched > 0 ? correctMatches / matched : 1;
  const abstainRate = abstained / fixtures.length;
  assert.strictEqual(precision, 1);
  assert.ok(abstainRate >= 1 / 3);
}

function testAccuracyFixtureLoaderSmoke() {
  const fixtures = accuracyLib.loadFixtures({ suite: 'gold' });
  assert.ok(Array.isArray(fixtures), 'Expected benchmark fixture loader to return an array');
  assert.ok(fixtures.length > 0, 'Expected benchmark gold fixtures to exist');
}

function testBundledCoreConferenceSearchStatus() {
  const sigcomm = resolveBundledCoreVenue('CORE_2026.json', 'SIGCOMM');
  assert.strictEqual(sigcomm.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(sigcomm.rank, 'A*');

  const sensysCurrent = resolveBundledCoreVenue('CORE_2026.json', 'SenSys');
  assert.strictEqual(sensysCurrent.status, core.DECISION_STATUS.UNRANKED);
  assert.strictEqual(sensysCurrent.rank, 'N/A');
  assert.strictEqual(String(sensysCurrent.rawRankLabel || '').toLowerCase(), 'unranked: merged');

  const sensysHistorical = resolveBundledCoreVenue('CORE_2023.json', 'SenSys');
  assert.strictEqual(sensysHistorical.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(sensysHistorical.rank, 'A*');

  const nsdiCurrent = resolveBundledCoreVenue('CORE_2026.json', 'NSDI');
  assert.strictEqual(nsdiCurrent.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(nsdiCurrent.rank, 'A*');
  assert.strictEqual(nsdiCurrent.matchType, 'top_venue_fallback');
}

function testJournalLookupCacheScopesIssnBackedMatches() {
  const journalName = 'ISSN lookup 1';
  const publicationYear = 2019;
  const normalizedQuery = accuracyLib.generateJournalNormalizationVariants(journalName)[0];
  const titleOnly = accuracyLib.resolveJournalQuerySync(journalName, publicationYear, {});
  const issnBacked = accuracyLib.resolveJournalQuerySync(journalName, publicationYear, { issns: ['03899160'] });

  assert.strictEqual(titleOnly.status, core.DECISION_STATUS.MISSING);
  assert.strictEqual(issnBacked.status, core.DECISION_STATUS.MATCHED);
  assert.strictEqual(issnBacked.quartile, 'Q4');
  assert.notStrictEqual(
    core.buildJournalLookupCacheKey(normalizedQuery, []),
    core.buildJournalLookupCacheKey(normalizedQuery, ['0389-9160']),
    'ISSN-backed depth lookups should not reuse a title-only cache miss'
  );
}

function testCommonDblpJournalAbbreviationsResolveWithoutStreamMetadata() {
  const cases = [
    { name: 'Wirel. Pers. Commun.', year: 2021, quartile: 'Q2' },
    { name: 'ACM Trans. Embed. Comput. Syst.', year: 2020, quartile: 'Q2' },
    { name: 'J. Parallel Distributed Comput.', year: 2022, quartile: 'Q1' },
    { name: 'Comput. Commun.', year: 2023, quartile: 'Q1' },
    { name: 'J. Syst. Archit.', year: 2023, quartile: 'Q1' },
    { name: 'IEEE Internet Things J.', year: 2024, quartile: 'Q1' },
    { name: 'Int. J. Distributed Sens. Networks', year: 2015, quartile: 'Q2' },
  ];

  for (const fixture of cases) {
    const result = accuracyLib.resolveJournalQuerySync(fixture.name, fixture.year, {});
    assert.strictEqual(
      result.status,
      core.DECISION_STATUS.MATCHED,
      `Expected ${fixture.name} to resolve locally without DBLP stream metadata`
    );
    assert.strictEqual(result.quartile, fixture.quartile);
  }
}

async function run() {
  testDeterministicDblpMatch();
  testWorkshopClassification();
  testDemoPosterClassification();
  testAmbiguousDblpMatchAbstains();
  testDemoKeywordNotTrackWhenPagesHigh();
  testDemoKeywordNotTrackEvenWithoutPages();
  testExtendedAbstractClassification();
  testLetterPrefixPagesParsing();
  testPlusNormalization();
  testSettingsNormalization();
  testRankingPackNormalization();
  testFeatureStateNormalization();
  testCacheMetadataHelpers();
  testTimelineFilteringAndCounts();
  testTimelineRankCountRecomputation();
  testFixedWindowTimelineHistogram();
  testFullTimelineHistogramFillsKnownYearGaps();
  testFocusedTimelineHistograms();
  testTimelineStatsIncludesFocusedWindows();
  testSummaryDistributionRenderUsesFilteredCounts();
  testReportTimelineChartsUseStackedHorizontalLayout();
  testGeneratedSjrIndex();
  testJournalIdentityModelRegression();
  testDiacriticFoldingInMatching();
  testHistoricalCoreSnapshots();
  testTitleAtSignDoesNotMakeWorkshop();
  testTruncatedTitleMatching();
  testAcronymTitleCrossCheck();
  testHistoricalSjrCoverageUnavailable();
  testCoreAliasResolution();
  testAmbiguousCoreAcronymAbstains();
  testProfileCandidateScoring();
  testManualDblpPidExtraction();
  testProfileCacheReuseRequiresVerifiedPid();
  testDblpPidSelectionPrecedence();
  testManualDblpUiSmoke();
  testDblpPersonXmlScholarUrlParsing();
  testScholarVerificationSampleBuilder();
  testProfileVerificationCandidateSelection();
  testProfileVerificationEscalationGate();
  testWolfgangScholarUserRegression();
  testPersistentDblpCacheKeyBuilders();
  testLocalVenueCandidateBuilder();
  testLocalFirstStreamReductionSourceSmoke();
  testFixtureCorpusMetrics();
  testBundledCoreConferenceSearchStatus();
  testJournalLookupCacheScopesIssnBackedMatches();
  testCommonDblpJournalAbbreviationsResolveWithoutStreamMetadata();
  testAccuracyFixtureLoaderSmoke();
  testShortPaperByPages();
  testVenueNormalization();
  runScoreTests();
  await runDblpSchedulerTests();

  console.log('All tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
