const assert = require('assert');
const fs = require('fs');
const path = require('path');

const core = require('../rank_core.js');
const settings = require('../settings.js');
const accuracyLib = require('./accuracy_benchmark_lib.js');
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
  assert.deepStrictEqual(normalized, ['core', 'sjr', 'ccf']);

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
  assert.deepStrictEqual(rankingPacks, ['core', 'sjr', 'era']);
}

function testGeneratedSjrIndex() {
  const indexPath = path.join(__dirname, '..', 'data', 'sjr-index.json');
  assert.ok(fs.existsSync(indexPath), 'Expected generated SJR index to exist');

  const payload = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.strictEqual(payload.version, 2);
  assert.ok(Array.isArray(payload.entries), 'Expected compact SJR entries array');
  assert.ok(payload.entries.length > 30000, 'Expected compact SJR index to contain the bundled journals');

  const tpami = payload.entries.find((entry) => entry.n === 'ieee transaction pattern analysi machine intelligence');
  assert.ok(tpami, 'Expected TPAMI normalized journal entry to exist');
  assert.strictEqual(tpami.q['2024'], 'Q1');
  assert.ok(Array.isArray(tpami.i), 'Expected SJR entries to include ISSN metadata');
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

function run() {
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
  testGeneratedSjrIndex();
  testCoreAliasResolution();
  testAmbiguousCoreAcronymAbstains();
  testProfileCandidateScoring();
  testFixtureCorpusMetrics();
  testBundledCoreConferenceSearchStatus();
  testAccuracyFixtureLoaderSmoke();
  testShortPaperByPages();
  testVenueNormalization();

  console.log('All tests passed.');
}

run();
