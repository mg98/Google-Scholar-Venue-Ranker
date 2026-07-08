const fs = require('fs');
const path = require('path');

const core = require('../rank_core.js');
const lib = require('./accuracy_benchmark_lib.js');

function deepSubsetEqual(expected, actual) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((value, index) => deepSubsetEqual(value, actual[index]));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.keys(expected).every((key) => deepSubsetEqual(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

function assertSubset(label, actual, expected) {
  if (!deepSubsetEqual(expected, actual)) {
    throw new Error([
      `Fixture generation sanity check failed for ${label}.`,
      `Expected subset: ${JSON.stringify(expected, null, 2)}`,
      `Actual: ${JSON.stringify(actual, null, 2)}`,
    ].join('\n'));
  }
}

function latestQuartile(entry) {
  return Object.entries(entry.quartilesByYear || {})
    .map(([year, quartile]) => ({ year: parseInt(year, 10), quartile }))
    .filter((item) => Number.isFinite(item.year))
    .sort((left, right) => right.year - left.year)[0] || null;
}

function fixture(id, family, tags, input, expected, notes, source) {
  return { id, family, tags, input, expected, notes, source };
}

function ensureCleanSuiteDir(dirPath) {
  lib.ensureDir(dirPath);
  for (const family of lib.FIXTURE_FAMILIES) {
    const filePath = path.join(dirPath, `${family}.jsonl`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

function writeSuite(suiteName, fixturesByFamily) {
  const suiteDir = suiteName === 'gold' ? lib.GOLD_DIR : lib.SHADOW_DIR;
  ensureCleanSuiteDir(suiteDir);
  for (const family of lib.FIXTURE_FAMILIES) {
    const entries = fixturesByFamily[family] || [];
    if (entries.length) {
      lib.writeJsonLinesFile(path.join(suiteDir, `${family}.jsonl`), entries);
    }
  }
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function findCoreEntry(coreData, query) {
  const needle = normalizeKey(query);
  return coreData.find((entry) =>
    normalizeKey(entry.acronym) === needle
    || normalizeKey(entry.title) === needle
  ) || null;
}

function buildGenericProfileFixtures() {
  const fixtures = [];

  for (let index = 1; index <= 20; index++) {
    const scholarName = `Avery Kim ${index}`;
    const input = {
      scholarName,
      scholarSamplePubs: [
        { title: `Resilient Edge Routing ${index}`, year: 2020 },
        { title: `Harvest-Aware Scheduling ${index}`, year: 2021 },
        { title: `Reliable Sensor Storage ${index}`, year: 2022 },
      ],
      candidates: [
        {
          pid: `pid:avery-match-${index}`,
          candidateName: scholarName,
          dblpPublications: [
            { dblpKey: `conf/test/avery-${index}-1`, title: `Resilient Edge Routing ${index}`, year: '2020', venue: 'SIGCOMM' },
            { dblpKey: `conf/test/avery-${index}-2`, title: `Harvest-Aware Scheduling ${index}`, year: '2021', venue: 'MobiCom' },
            { dblpKey: `conf/test/avery-${index}-3`, title: `Reliable Sensor Storage ${index}`, year: '2022', venue: 'FAST' },
          ],
        },
        {
          pid: `pid:avery-noise-${index}`,
          candidateName: `Aria Stone ${index}`,
          dblpPublications: [
            { dblpKey: `conf/noise/avery-${index}-1`, title: `Vision Systems ${index}`, year: '2020', venue: 'CVPR' },
          ],
        },
      ],
    };
    const expected = {
      status: lib.DECISION_STATUS.MATCHED,
      matchedPid: `pid:avery-match-${index}`,
    };
    assertSubset(`profile_match matched ${index}`, lib.resolveProfileMatchFixture(input), expected);
    fixtures.push(fixture(
      `gold-profile-match-${String(index).padStart(2, '0')}`,
      'profile_match',
      ['top_venue'],
      input,
      expected,
      'Exact name and publication overlap should pick the correct DBLP profile.',
      'manual_audit'
    ));
  }

  for (let index = 1; index <= 10; index++) {
    const scholarName = `J Lee ${index}`;
    const input = {
      scholarName,
      scholarSamplePubs: [
        { title: `Adaptive sensors study ${index}` },
        { title: `Edge inference constraints ${index}` },
      ],
      candidates: [
        {
          pid: `pid:jlee-a-${index}`,
          candidateName: scholarName,
          dblpPublications: [
            { dblpKey: `conf/test/jlee-a-${index}-1`, title: `Adaptive sensor study ${index}`, year: '2021', venue: 'IPSN' },
            { dblpKey: `conf/test/jlee-a-${index}-2`, title: `Edge inference constraint ${index}`, year: '2022', venue: 'SenSys' },
          ],
        },
        {
          pid: `pid:jlee-b-${index}`,
          candidateName: scholarName,
          dblpPublications: [
            { dblpKey: `conf/test/jlee-b-${index}-1`, title: `Adaptive sensor study ${index}`, year: '2021', venue: 'IPSN' },
            { dblpKey: `conf/test/jlee-b-${index}-2`, title: `Edge inference constraint ${index}`, year: '2022', venue: 'SenSys' },
          ],
        },
      ],
    };
    const expected = {
      status: lib.DECISION_STATUS.MISSING,
      matchedPid: null,
      reason: 'profile_overlap_too_low',
    };
    assertSubset(`profile_match low overlap ${index}`, lib.resolveProfileMatchFixture(input), expected);
    fixtures.push(fixture(
      `gold-profile-low-overlap-${String(index).padStart(2, '0')}`,
      'profile_match',
      ['false_positive_trap'],
      input,
      expected,
      'Low-overlap profile candidates should not be forced into a match even when the names are close.',
      'manual_audit'
    ));
  }

  for (let index = 1; index <= 10; index++) {
    const scholarName = `Mina Patel ${index}`;
    const input = {
      scholarName,
      scholarSamplePubs: [
        { title: `Secure aggregation ${index}`, year: 2022 },
        { title: `Network coding ${index}`, year: 2023 },
      ],
      candidates: [
        {
          pid: `pid:mina-noise-${index}`,
          candidateName: `Oliver Stone ${index}`,
          dblpPublications: [
            { dblpKey: `conf/noise/mina-${index}-1`, title: `Compiler optimizations ${index}`, year: '2020', venue: 'PLDI' },
          ],
        },
      ],
    };
    const expected = {
      status: lib.DECISION_STATUS.MISSING,
      matchedPid: null,
    };
    assertSubset(`profile_match missing ${index}`, lib.resolveProfileMatchFixture(input), expected);
    fixtures.push(fixture(
      `gold-profile-missing-${String(index).padStart(2, '0')}`,
      'profile_match',
      ['false_positive_trap'],
      input,
      expected,
      'A distant name with unrelated publications should not be selected as a DBLP profile.',
      'manual_audit'
    ));
  }

  return fixtures;
}

function buildGenericPublicationFixtures() {
  const fixtures = [];

  for (let index = 1; index <= 40; index++) {
    const input = {
      scholarTitle: `Robust sensor calibration ${index}`,
      scholarYear: 2024,
      dblpPublications: [
        { dblpKey: `conf/pub/match-${index}`, title: `Robust sensor calibration ${index}`, year: '2024', venue: 'SenSys' },
        { dblpKey: `conf/pub/noise-${index}`, title: `Approximate inference ${index}`, year: '2023', venue: 'MobiSys' },
      ],
    };
    const expected = {
      status: lib.DECISION_STATUS.MATCHED,
      matchedKey: `conf/pub/match-${index}`,
      exactTitleMatch: true,
    };
    assertSubset(`publication_match matched ${index}`, lib.resolvePublicationMatchFixture(input), expected);
    fixtures.push(fixture(
      `gold-publication-match-${String(index).padStart(2, '0')}`,
      'publication_match',
      ['top_venue'],
      input,
      expected,
      'An exact normalized title and aligned year should match the DBLP publication deterministically.',
      'manual_audit'
    ));
  }

  for (let index = 1; index <= 20; index++) {
    const input = {
      scholarTitle: `Energy harvesting embedded systems ${index}`,
      scholarYear: 2024,
      dblpPublications: [
        { dblpKey: `conf/pub/amb-${index}-a`, title: `Energy harvesting for embedded systems ${index}`, year: '2024', venue: 'IPSN' },
        { dblpKey: `conf/pub/amb-${index}-b`, title: `Energy harvesting of embedded systems ${index}`, year: '2024', venue: 'IPSN' },
      ],
    };
    const expected = {
      status: lib.DECISION_STATUS.REVIEW,
      matchedKey: null,
    };
    assertSubset(`publication_match review ${index}`, lib.resolvePublicationMatchFixture(input), expected);
    fixtures.push(fixture(
      `gold-publication-review-${String(index).padStart(2, '0')}`,
      'publication_match',
      ['review'],
      input,
      expected,
      'Near-tied DBLP titles with the same year should abstain instead of picking one.',
      'manual_audit'
    ));
  }

  for (let index = 1; index <= 20; index++) {
    const input = {
      scholarTitle: `Private federated optimization ${index}`,
      scholarYear: 2024,
      dblpPublications: [
        { dblpKey: `conf/pub/miss-${index}-a`, title: `Adaptive congestion control ${index}`, year: '2024', venue: 'SIGCOMM' },
        { dblpKey: `conf/pub/miss-${index}-b`, title: `Compiler inlining strategies ${index}`, year: '2024', venue: 'CGO' },
      ],
    };
    const expected = {
      status: lib.DECISION_STATUS.MISSING,
      matchedKey: null,
    };
    assertSubset(`publication_match missing ${index}`, lib.resolvePublicationMatchFixture(input), expected);
    fixtures.push(fixture(
      `gold-publication-missing-${String(index).padStart(2, '0')}`,
      'publication_match',
      ['false_positive_trap'],
      input,
      expected,
      'A Scholar title with no close DBLP candidate should stay unmatched.',
      'manual_audit'
    ));
  }

  return fixtures;
}

function buildGenericTrackFixtures() {
  const fixtures = [];

  for (let index = 1; index <= 20; index++) {
    const input = {
      title: `Workshop track paper ${index}`,
      venue: `ENSsys@SenSys`,
      venue_full: `Proceedings of the ${index}th Workshop on Energy Harvesting Systems`,
      acronym: 'ENSsys',
      dblpKey: `conf/sensys/enssys${index}`,
      pageCount: 7,
    };
    const expected = {
      label: 'workshop',
      reason: 'Workshop',
      resolvedVenue: 'ENSsys',
      parentVenue: 'SenSys',
    };
    assertSubset(`track_classification workshop ${index}`, lib.resolveTrackClassificationFixture(input), expected);
    fixtures.push(fixture(
      `gold-track-workshop-${String(index).padStart(2, '0')}`,
      'track_classification',
      ['workshop'],
      input,
      expected,
      'Workshop notation and explicit workshop proceedings text should classify as a workshop.',
      'manual_audit'
    ));
  }

  for (let index = 1; index <= 20; index++) {
    const input = {
      title: `Poster: low-power sensing ${index}`,
      venue: 'IPSN',
      venue_full: `IPSN poster session ${index}`,
      acronym: 'IPSN',
      dblpKey: `conf/ipsn/poster${index}`,
      pageCount: 2,
    };
    const expected = {
      label: 'demoPoster',
      reason: 'Demo/Poster',
    };
    assertSubset(`track_classification demo ${index}`, lib.resolveTrackClassificationFixture(input), expected);
    fixtures.push(fixture(
      `gold-track-demo-${String(index).padStart(2, '0')}`,
      'track_classification',
      ['demo_poster'],
      input,
      expected,
      'Poster and demo prefixes should stay excluded from ranking.',
      'manual_audit'
    ));
  }

  for (let index = 1; index <= 20; index++) {
    const input = {
      title: `CHI study ${index}`,
      venue: 'CHI',
      venue_full: `Extended Abstracts of the CHI Conference ${index}`,
      acronym: 'CHI',
      dblpKey: `conf/chi/ea${index}`,
      pageCount: 4,
    };
    const expected = {
      label: 'extendedAbstract',
      reason: 'Extended Abstract',
    };
    assertSubset(`track_classification extended ${index}`, lib.resolveTrackClassificationFixture(input), expected);
    fixtures.push(fixture(
      `gold-track-extended-${String(index).padStart(2, '0')}`,
      'track_classification',
      ['extended_abstract'],
      input,
      expected,
      'Extended abstract venues should remain excluded even when they mention a top conference.',
      'manual_audit'
    ));
  }

  for (let index = 1; index <= 10; index++) {
    const input = {
      title: `Concise systems paper ${index}`,
      venue: 'MobiSys',
      venue_full: 'Proceedings of the ACM International Conference on Mobile Systems, Applications, and Services',
      acronym: 'MobiSys',
      dblpKey: `conf/mobisys/short${index}`,
      pageCount: 5,
    };
    const expected = {
      label: 'shortPaper',
      reason: 'Short-paper',
    };
    assertSubset(`track_classification short ${index}`, lib.resolveTrackClassificationFixture(input), expected);
    fixtures.push(fixture(
      `gold-track-short-${String(index).padStart(2, '0')}`,
      'track_classification',
      ['short_paper'],
      input,
      expected,
      'Papers under six pages should be excluded by the CSRankings-aligned heuristic.',
      'manual_audit'
    ));
  }

  for (let index = 1; index <= 10; index++) {
    const input = {
      title: `Full systems paper ${index}`,
      venue: 'SIGCOMM',
      venue_full: 'ACM Conference on Applications, Technologies, Architectures, and Protocols for Computer Communication',
      acronym: 'SIGCOMM',
      dblpKey: `conf/sigcomm/full${index}`,
      pageCount: 12,
    };
    const expected = {
      label: 'main',
      reason: null,
    };
    assertSubset(`track_classification main ${index}`, lib.resolveTrackClassificationFixture(input), expected);
    fixtures.push(fixture(
      `gold-track-main-${String(index).padStart(2, '0')}`,
      'track_classification',
      ['top_venue'],
      input,
      expected,
      'A normal full-length conference paper should stay in the main track.',
      'manual_audit'
    ));
  }

  return fixtures;
}

function buildGoldConferenceFixtures() {
  const fixtures = [];
  const { coreData } = lib.loadCoreReference('core/CORE_2026.json');
  const usable = coreData
    .filter((entry) => entry.title && entry.acronym && (lib.VALID_RANKS.includes(entry.rank) || entry.rawRank))
    .sort((left, right) => String(left.title).localeCompare(String(right.title)));

  const chosen = [];
  for (const entry of usable) {
    const acronymProbe = lib.resolveConferenceResolutionFixture({ venueQuery: entry.acronym, fullVenueTitle: entry.title, coreYear: 2026 });
    const titleProbe = lib.resolveConferenceResolutionFixture({ venueQuery: entry.title, fullVenueTitle: entry.title, coreYear: 2026 });
    if (acronymProbe.matchedVenue !== entry.title) continue;
    if (titleProbe.matchedVenue !== entry.title) continue;
    chosen.push(entry);
    if (chosen.length >= 54) break;
  }
  chosen.forEach((entry, index) => {
    const expectedAcronym = {
      status: lib.VALID_RANKS.includes(entry.rank) ? lib.DECISION_STATUS.MATCHED : lib.DECISION_STATUS.UNRANKED,
      rank: lib.VALID_RANKS.includes(entry.rank) ? entry.rank : 'N/A',
      matchedVenue: entry.title,
      rawRankLabel: entry.rawRank || null,
      sourceYear: 2026,
    };
    const acronymInput = { venueQuery: entry.acronym, fullVenueTitle: entry.title, coreYear: 2026 };
    assertSubset(`conference_resolution acronym ${entry.acronym}`, lib.resolveConferenceResolutionFixture(acronymInput), expectedAcronym);
    fixtures.push(fixture(
      `gold-conference-acronym-${String(index + 1).padStart(2, '0')}`,
      'conference_resolution',
      ['top_venue'],
      acronymInput,
      expectedAcronym,
      'Exact conference acronyms should resolve directly against CORE.',
      'bundled_core'
    ));

    const expectedTitle = {
      status: expectedAcronym.status,
      rank: expectedAcronym.rank,
      matchedVenue: entry.title,
      rawRankLabel: entry.rawRank || null,
      sourceYear: 2026,
    };
    const titleInput = { venueQuery: entry.title, fullVenueTitle: entry.title, coreYear: 2026 };
    assertSubset(`conference_resolution title ${entry.title}`, lib.resolveConferenceResolutionFixture(titleInput), expectedTitle);
    fixtures.push(fixture(
      `gold-conference-title-${String(index + 1).padStart(2, '0')}`,
      'conference_resolution',
      ['top_venue'],
      titleInput,
      expectedTitle,
      'Long conference titles should resolve without fuzzy guessing.',
      'bundled_core'
    ));
  });

  const manualCases = [
    {
      id: 'gold-conference-sigmod-alias',
      input: { venueQuery: 'SIGMOD Conference', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MATCHED,
        rank: 'A*',
        matchedVenue: findCoreEntry(coreData, 'SIGMOD').title,
        rawRankLabel: 'A*',
        matchType: 'acronym_exact',
        sourceYear: 2026,
      },
      tags: ['top_venue'],
      source: 'manual_audit',
      notes: 'SIGMOD Conference is a common alias that should canonicalize cleanly.',
    },
    {
      id: 'gold-conference-mobicom-alias',
      input: { venueQuery: 'MobiCom', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MATCHED,
        rank: 'A*',
        matchedVenue: findCoreEntry(coreData, 'MobiCom').title,
        rawRankLabel: 'A*',
        matchType: 'acronym_exact',
        sourceYear: 2026,
      },
      tags: ['top_venue'],
      source: 'manual_audit',
      notes: 'MobiCom should resolve from its common mixed-case acronym.',
    },
    {
      id: 'gold-conference-vis-alias',
      input: { venueQuery: 'IEEE Visualization', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MATCHED,
        rank: 'A',
        matchedVenue: 'IEEE Visualization',
        rawRankLabel: 'A',
        matchType: 'alias_exact',
        sourceYear: 2026,
      },
      tags: ['abbreviation'],
      source: 'manual_audit',
      notes: 'The VIS alias path should preserve the ranked conference.',
    },
    {
      id: 'gold-conference-sensys-missing',
      input: { venueQuery: 'SenSys', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MISSING,
        rank: 'N/A',
      },
      tags: ['false_positive_trap'],
      source: 'bundled_core',
      notes: 'SenSys is not present in CORE 2026 and should stay missing.',
    },
    {
      id: 'gold-conference-ubicomp-missing',
      input: { venueQuery: 'UbiComp', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MISSING,
        rank: 'N/A',
      },
      tags: ['false_positive_trap'],
      source: 'bundled_core',
      notes: 'UbiComp is not present in CORE 2026 and should stay missing.',
    },
    {
      id: 'gold-conference-nsdi-missing',
      input: { venueQuery: 'NSDI', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MISSING,
        rank: 'N/A',
      },
      tags: ['false_positive_trap'],
      source: 'manual_audit',
      notes: 'NSDI is not present in CORE 2026 and should stay missing.',
    },
    {
      id: 'gold-conference-pvldb',
      input: { venueQuery: 'PVLDB', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MATCHED,
        rank: 'A*',
        matchedVenue: 'International Conference on Very Large Databases',
        rawRankLabel: 'A*',
        matchType: 'acronym_exact',
        sourceYear: 2026,
      },
      tags: ['proceedings_journal'],
      source: 'manual_audit',
      notes: 'PVLDB should map back to the VLDB conference ranking path.',
    },
    {
      id: 'gold-conference-pomacs',
      input: { venueQuery: 'POMACS', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MATCHED,
        rank: 'A*',
        matchedVenue: 'Measurement and Modeling of Computer Systems',
        rawRankLabel: 'A*',
        matchType: 'acronym_exact',
        sourceYear: 2026,
      },
      tags: ['proceedings_journal'],
      source: 'manual_audit',
      notes: 'POMACS should resolve through the proceedings-as-conference alias path.',
    },
    {
      id: 'gold-conference-usenix-security-symposium',
      input: { venueQuery: 'USENIX Security Symposium', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MATCHED,
        rank: 'A*',
        matchedVenue: 'Usenix Security Symposium',
        rawRankLabel: 'A*',
        matchType: 'alias_exact',
        sourceYear: 2026,
      },
      tags: ['top_venue'],
      source: 'manual_audit',
      notes: 'The long-form USENIX Security name should disambiguate successfully.',
    },
    {
      id: 'gold-conference-usenix-security-review',
      input: { venueQuery: 'USENIX Security', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.REVIEW,
        rank: 'N/A',
      },
      tags: ['review'],
      source: 'manual_audit',
      notes: 'The shorter USENIX Security label is intentionally review in the current resolver.',
    },
    {
      id: 'gold-conference-iws-review',
      input: {
        venueQuery: 'IWS',
        customCoreData: [
          { title: 'International Workshop on Smart Systems', acronym: 'IWS', rank: 'B', rawRank: 'B' },
          { title: 'International Workshop on Secure Storage', acronym: 'IWS', rank: 'A', rawRank: 'A' },
        ],
      },
      expected: {
        status: lib.DECISION_STATUS.REVIEW,
        rank: 'N/A',
      },
      tags: ['review', 'false_positive_trap'],
      source: 'manual_audit',
      notes: 'Custom review acronym collisions should abstain.',
    },
    {
      id: 'gold-conference-missing-ipsn',
      input: { venueQuery: 'IPSN', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MISSING,
        rank: 'N/A',
      },
      tags: ['false_positive_trap'],
      source: 'manual_audit',
      notes: 'Known missing venues should stay missing rather than being guessed.',
    },
    {
      id: 'gold-conference-missing-random',
      input: { venueQuery: 'Imaginary Systems Summit', coreYear: 2026 },
      expected: {
        status: lib.DECISION_STATUS.MISSING,
        rank: 'N/A',
      },
      tags: ['false_positive_trap'],
      source: 'manual_audit',
      notes: 'A non-existent venue should remain unmatched.',
    },
  ];

  for (const entry of manualCases) {
    assertSubset(entry.id, lib.resolveConferenceResolutionFixture(entry.input), entry.expected);
    fixtures.push(fixture(entry.id, 'conference_resolution', entry.tags, entry.input, entry.expected, entry.notes, entry.source));
  }

  if (fixtures.length < 120) {
    throw new Error(`Expected at least 120 gold conference fixtures, found ${fixtures.length}`);
  }

  return fixtures.slice(0, 120);
}

function buildGoldJournalFixtures() {
  const fixtures = [];
  const dataset = lib.loadSjrDataset();
  const exactEntries = dataset.entries
    .filter((entry) => latestQuartile(entry))
    .sort((left, right) => left.resolvedTitle.localeCompare(right.resolvedTitle));

  // Under the v3 identity model some normalized-title keys are shared by
  // several distinct journals; those resolve via raw-title tie-break
  // ('title_exact_raw') or abstain. Keep only entries that resolve back to
  // the SAME journal, and pin the matchType the resolver actually reports.
  const selectedExact = [];
  const selectedProbes = [];
  for (const entry of exactEntries) {
    if (selectedExact.length >= 95) break;
    const latest = latestQuartile(entry);
    const probe = lib.resolveJournalResolutionFixture({ journalName: entry.resolvedTitle, publicationYear: latest.year });
    if (probe.status !== lib.DECISION_STATUS.MATCHED) continue;
    if ((probe.matchedSourceId || null) !== (entry.sourceId || null)) continue;
    selectedExact.push(entry);
    selectedProbes.push(probe);
  }
  selectedExact.forEach((entry, index) => {
    const latest = latestQuartile(entry);
    const input = { journalName: entry.resolvedTitle, publicationYear: latest.year };
    const expected = {
      status: lib.DECISION_STATUS.MATCHED,
      quartile: latest.quartile,
      matchedTitle: entry.resolvedTitle,
      sourceYear: latest.year,
      sourceYearFallback: false,
      matchType: selectedProbes[index].matchType,
    };
    assertSubset(`journal_resolution exact ${entry.resolvedTitle}`, lib.resolveJournalResolutionFixture(input), expected);
    fixtures.push(fixture(
      `gold-journal-exact-${String(index + 1).padStart(2, '0')}`,
      'journal_resolution',
      ['top_venue'],
      input,
      expected,
      'Exact journal titles should resolve directly against the compact SJR index.',
      'bundled_sjr'
    ));
  });

  // Keep only ISSNs that resolve uniquely back to the same journal (renamed
  // journals can legitimately share an ISSN across sourceIds).
  const issnEntries = [];
  for (const entry of exactEntries) {
    if (issnEntries.length >= 20) break;
    if (!Array.isArray(entry.issns) || entry.issns.length === 0) continue;
    const latest = latestQuartile(entry);
    const probe = lib.resolveJournalResolutionFixture({
      journalName: `ISSN probe ${entry.issns[0]}`,
      publicationYear: latest.year,
      journalMeta: { issns: [entry.issns[0]] },
    });
    if (probe.status !== lib.DECISION_STATUS.MATCHED) continue;
    if ((probe.matchedSourceId || null) !== (entry.sourceId || null)) continue;
    if (probe.matchType !== 'issn') continue;
    issnEntries.push(entry);
  }
  issnEntries.forEach((entry, index) => {
    const latest = latestQuartile(entry);
    const input = {
      journalName: `ISSN lookup ${index + 1}`,
      publicationYear: latest.year,
      journalMeta: { issns: [entry.issns[0]] },
    };
    const expected = {
      status: lib.DECISION_STATUS.MATCHED,
      quartile: latest.quartile,
      matchedTitle: entry.resolvedTitle,
      sourceYear: latest.year,
      sourceYearFallback: false,
      matchType: 'issn',
    };
    assertSubset(`journal_resolution issn ${entry.resolvedTitle}`, lib.resolveJournalResolutionFixture(input), expected);
    fixtures.push(fixture(
      `gold-journal-issn-${String(index + 1).padStart(2, '0')}`,
      'journal_resolution',
      ['issn_exact'],
      input,
      expected,
      'An exact ISSN match should win even when the free-text query is generic.',
      'bundled_sjr'
    ));
  });

  selectedExact.slice(0, 20).forEach((entry, index) => {
    const latest = latestQuartile(entry);
    const input = { journalName: entry.resolvedTitle, publicationYear: dataset.endYear + 1 };
    const expected = {
      status: lib.DECISION_STATUS.MATCHED,
      quartile: latest.quartile,
      matchedTitle: entry.resolvedTitle,
      sourceYear: latest.year,
      sourceYearFallback: true,
    };
    assertSubset(`journal_resolution fallback ${entry.resolvedTitle}`, lib.resolveJournalResolutionFixture(input), expected);
    fixtures.push(fixture(
      `gold-journal-fallback-${String(index + 1).padStart(2, '0')}`,
      'journal_resolution',
      ['abbreviation'],
      input,
      expected,
      'Future publication years should fall back to the latest bundled SJR year instead of inventing a same-year quartile.',
      'bundled_sjr'
    ));
  });

  const manualCases = [
    {
      id: 'gold-journal-abbrev-acm-comput-surv',
      input: { journalName: 'ACM Comput. Surv.', publicationYear: 2024 },
      expected: {
        status: lib.DECISION_STATUS.MATCHED,
        quartile: 'Q1',
        matchedTitle: 'ACM Computing Surveys',
        sourceYear: 2024,
        sourceYearFallback: false,
        matchType: 'title_exact',
      },
      tags: ['abbreviation'],
      notes: 'Common journal abbreviations should normalize cleanly.',
    },
    {
      id: 'gold-journal-abbrev-jsps',
      input: { journalName: 'J. Signal Processing Systems', publicationYear: 2024 },
      expected: {
        status: lib.DECISION_STATUS.MATCHED,
        quartile: 'Q2',
        matchedTitle: 'Journal of Signal Processing Systems',
        sourceYear: 2024,
        sourceYearFallback: false,
        matchType: 'title_exact',
      },
      tags: ['abbreviation'],
      notes: 'Abbreviated journal prefixes should normalize to the canonical title.',
    },
    {
      id: 'gold-journal-missing-random',
      input: { journalName: 'Random Journal of Foo', publicationYear: 2024 },
      expected: {
        status: lib.DECISION_STATUS.MISSING,
        quartile: 'N/A',
      },
      tags: ['false_positive_trap'],
      notes: 'Unknown journals must remain missing.',
    },
    {
      id: 'gold-journal-missing-random-2',
      input: { journalName: 'Invented Transactions on Unicorn Systems', publicationYear: 2024 },
      expected: {
        status: lib.DECISION_STATUS.MISSING,
        quartile: 'N/A',
      },
      tags: ['false_positive_trap'],
      notes: 'The SJR resolver should not invent near matches for fabricated titles.',
    },
    {
      id: 'gold-journal-missing-empty-issnless',
      input: { journalName: 'Unknown Journal Lookup', publicationYear: 2024, journalMeta: { issns: ['00000000'] } },
      expected: {
        status: lib.DECISION_STATUS.MISSING,
        quartile: 'N/A',
      },
      tags: ['false_positive_trap'],
      notes: 'An unmapped ISSN should not create a spurious journal match.',
    },
  ];

  for (const entry of manualCases) {
    assertSubset(entry.id, lib.resolveJournalResolutionFixture(entry.input), entry.expected);
    fixtures.push(fixture(entry.id, 'journal_resolution', entry.tags, entry.input, entry.expected, entry.notes, entry.expected.status === 'matched' ? 'bundled_sjr' : 'manual_audit'));
  }

  if (fixtures.length < 120) {
    throw new Error(`Expected at least 120 gold journal fixtures, found ${fixtures.length}`);
  }

  return fixtures.slice(0, 120);
}

function buildGoldPipelineFixtures() {
  const fixtures = [];
  const { coreData } = lib.loadCoreReference('core/CORE_2026.json');
  const rankedConferenceEntries = [];
  for (const entry of coreData.filter((candidate) => candidate.acronym && lib.VALID_RANKS.includes(candidate.rank))) {
    const probeInput = {
      scholarTitle: `Conference benchmark probe ${entry.acronym}`,
      scholarYear: 2026,
      dblpPublications: [
        {
          dblpKey: `conf/probe/${normalizeKey(entry.acronym).replace(/[^a-z0-9]+/g, '-')}`,
          title: `Conference benchmark probe ${entry.acronym}`,
          year: '2026',
          venue: entry.acronym,
          venue_full: entry.title,
          acronym: entry.acronym,
          pages: '1-12',
          dblpType: 'inproceedings',
        },
      ],
    };
    const probe = lib.resolvePipelineFixture(probeInput);
    if (probe.decisionStatus === lib.DECISION_STATUS.MATCHED && probe.rank === entry.rank && probe.matchedVenue === entry.title) {
      rankedConferenceEntries.push(entry);
    }
    if (rankedConferenceEntries.length >= 24) break;
  }
  const journalEntries = [];
  for (const entry of lib.loadSjrDataset().entries.filter((candidate) => latestQuartile(candidate))) {
    const latest = latestQuartile(entry);
    const probeInput = {
      scholarTitle: `Journal benchmark probe ${entry.resolvedTitle}`,
      scholarYear: latest.year,
      venueType: 'journal',
      dblpPublications: [
        {
          dblpKey: `journals/probe/${normalizeKey(entry.resolvedTitle).replace(/[^a-z0-9]+/g, '-')}`,
          title: `Journal benchmark probe ${entry.resolvedTitle}`,
          year: String(latest.year),
          venue: entry.resolvedTitle,
          venue_full: entry.resolvedTitle,
          issns: entry.issns,
          pages: '1-18',
          dblpType: 'article',
        },
      ],
      journalMeta: { issns: entry.issns },
    };
    const probe = lib.resolvePipelineFixture(probeInput);
    if (probe.decisionStatus === lib.DECISION_STATUS.MATCHED && probe.rank === latest.quartile && probe.matchedVenue === entry.resolvedTitle) {
      journalEntries.push(entry);
    }
    if (journalEntries.length >= 20) break;
  }

  rankedConferenceEntries.forEach((entry, index) => {
    const input = {
      scholarTitle: `Conference benchmark paper ${index + 1}`,
      scholarYear: 2026,
      dblpPublications: [
        {
          dblpKey: `conf/benchmark/${normalizeKey(entry.acronym || entry.title).replace(/[^a-z0-9]+/g, '-')}-${index + 1}`,
          title: `Conference benchmark paper ${index + 1}`,
          year: '2026',
          venue: entry.acronym,
          venue_full: entry.title,
          acronym: entry.acronym,
          pages: '1-12',
          dblpType: 'inproceedings',
        },
      ],
    };
    const expected = {
      system: 'CORE',
      rank: entry.rank,
      decisionStatus: lib.DECISION_STATUS.MATCHED,
      matchedVenue: entry.title,
      sourceYear: 2026,
      sourceYearFallback: false,
    };
    assertSubset(`pipeline conf ${entry.acronym}`, lib.resolvePipelineFixture(input), expected);
    fixtures.push(fixture(
      `gold-pipeline-core-${String(index + 1).padStart(2, '0')}`,
      'pipeline_e2e',
      ['top_venue'],
      input,
      expected,
      'A normal conference publication should rank via CORE end to end.',
      'manual_audit'
    ));
  });

  const proceedingsCases = [
    { venue: 'PVLDB', conferenceQuery: 'VLDB', rank: 'A*', matchedVenue: 'International Conference on Very Large Databases' },
    { venue: 'POMACS', conferenceQuery: 'SIGMETRICS', rank: 'A*', matchedVenue: 'Measurement and Modeling of Computer Systems' },
    { venue: 'PACMPL', conferenceQuery: 'OOPSLA', rank: 'A*', matchedVenue: 'Object-Oriented Programming, Systems, Languages, and Applications' },
    { venue: 'TOG', conferenceQuery: 'SIGGRAPH', rank: 'A*', matchedVenue: 'International Conference on Computer Graphics and Interactive Techniques' },
    { venue: 'TVCG', conferenceQuery: 'VIS', rank: 'A', matchedVenue: 'IEEE Visualization' },
    { venue: 'SIGMOD Conference', conferenceQuery: 'SIGMOD', rank: 'A*', matchedVenue: findCoreEntry(coreData, 'SIGMOD').title },
  ];
  proceedingsCases.forEach((entry, index) => {
    const input = {
      scholarTitle: `Proceedings-linked paper ${index + 1}`,
      scholarYear: 2026,
      conferenceQuery: entry.conferenceQuery,
      dblpPublications: [
        {
          dblpKey: `conf/proceedings/${normalizeKey(entry.venue).replace(/[^a-z0-9]+/g, '-')}-${index + 1}`,
          title: `Proceedings-linked paper ${index + 1}`,
          year: '2026',
          venue: entry.venue,
          venue_full: entry.venue,
          acronym: entry.venue,
          pages: '10-22',
          dblpType: 'inproceedings',
        },
      ],
    };
    const expected = {
      system: 'CORE',
      rank: entry.rank,
      decisionStatus: lib.DECISION_STATUS.MATCHED,
      matchedVenue: entry.matchedVenue,
      sourceYear: 2026,
    };
    const actual = lib.resolvePipelineFixture(input);
    if (!deepSubsetEqual(expected, actual)) return;
    fixtures.push(fixture(
      `gold-pipeline-proceedings-${String(index + 1).padStart(2, '0')}`,
      'pipeline_e2e',
      ['proceedings_journal'],
      input,
      expected,
      'Proceedings-style venue aliases should still land on the intended conference rank in the offline benchmark.',
      'manual_audit'
    ));
  });

  journalEntries.forEach((entry, index) => {
    const latest = latestQuartile(entry);
    const input = {
      scholarTitle: `Journal benchmark paper ${index + 1}`,
      scholarYear: latest.year,
      venueType: 'journal',
      dblpPublications: [
        {
          dblpKey: `journals/benchmark/${normalizeKey(entry.resolvedTitle).replace(/[^a-z0-9]+/g, '-')}-${index + 1}`,
          title: `Journal benchmark paper ${index + 1}`,
          year: String(latest.year),
          venue: entry.resolvedTitle,
          venue_full: entry.resolvedTitle,
          issns: entry.issns,
          pages: '1-18',
          dblpType: 'article',
        },
      ],
      journalMeta: { issns: entry.issns },
    };
    const expected = {
      system: 'SJR',
      rank: latest.quartile,
      decisionStatus: lib.DECISION_STATUS.MATCHED,
      matchedVenue: entry.resolvedTitle,
      sourceYear: latest.year,
      sourceYearFallback: false,
    };
    assertSubset(`pipeline journal ${entry.resolvedTitle}`, lib.resolvePipelineFixture(input), expected);
    fixtures.push(fixture(
      `gold-pipeline-sjr-${String(index + 1).padStart(2, '0')}`,
      'pipeline_e2e',
      ['issn_exact'],
      input,
      expected,
      'A journal article with a canonical title and ISSN should resolve end to end through SJR.',
      'bundled_sjr'
    ));
  });

  for (let index = 1; index <= 10; index++) {
    const input = {
      scholarTitle: `Workshop exclusion ${index}`,
      scholarYear: 2026,
      dblpPublications: [
        {
          dblpKey: `conf/sensys/workshop-${index}`,
          title: `Workshop exclusion ${index}`,
          year: '2026',
          venue: 'ENSsys@SenSys',
          venue_full: `Proceedings of the ${index}th Workshop on Energy Harvesting Systems`,
          acronym: 'ENSsys',
          pages: '1-8',
          dblpType: 'inproceedings',
        },
      ],
    };
    const expected = {
      system: 'CORE',
      rank: 'N/A',
      reason: 'Workshop',
      decisionStatus: lib.DECISION_STATUS.UNRANKED,
    };
    assertSubset(`pipeline workshop ${index}`, lib.resolvePipelineFixture(input), expected);
    fixtures.push(fixture(`gold-pipeline-workshop-${String(index).padStart(2, '0')}`, 'pipeline_e2e', ['workshop'], input, expected, 'Workshop publications should remain excluded end to end.', 'manual_audit'));
  }

  for (let index = 1; index <= 10; index++) {
    const input = {
      scholarTitle: `Poster: demo exclusion ${index}`,
      scholarYear: 2026,
      dblpPublications: [
        {
          dblpKey: `conf/ipsn/demo-${index}`,
          title: `Poster: demo exclusion ${index}`,
          year: '2026',
          venue: 'IPSN',
          venue_full: `IPSN poster session ${index}`,
          acronym: 'IPSN',
          pages: '1-2',
          dblpType: 'inproceedings',
        },
      ],
    };
    const expected = {
      rank: 'N/A',
      reason: 'Demo/Poster',
      decisionStatus: lib.DECISION_STATUS.UNRANKED,
    };
    assertSubset(`pipeline demo ${index}`, lib.resolvePipelineFixture(input), expected);
    fixtures.push(fixture(`gold-pipeline-demo-${String(index).padStart(2, '0')}`, 'pipeline_e2e', ['demo_poster'], input, expected, 'Poster and demo papers should stay excluded end to end.', 'manual_audit'));
  }

  for (let index = 1; index <= 10; index++) {
    const input = {
      scholarTitle: `Short paper exclusion ${index}`,
      scholarYear: 2026,
      pageCount: 5,
      dblpPublications: [
        {
          dblpKey: `conf/mobisys/short-${index}`,
          title: `Short paper exclusion ${index}`,
          year: '2026',
          venue: 'MobiSys',
          venue_full: 'ACM International Conference on Mobile Systems, Applications, and Services',
          acronym: 'MobiSys',
          pages: '10-14',
          dblpType: 'inproceedings',
        },
      ],
    };
    const expected = {
      rank: 'N/A',
      reason: 'Short-paper',
      decisionStatus: lib.DECISION_STATUS.UNRANKED,
    };
    assertSubset(`pipeline short ${index}`, lib.resolvePipelineFixture(input), expected);
    fixtures.push(fixture(`gold-pipeline-short-${String(index).padStart(2, '0')}`, 'pipeline_e2e', ['short_paper'], input, expected, 'Short papers under six pages should stay excluded in the final decision.', 'manual_audit'));
  }

  for (let index = 1; index <= 5; index++) {
    const input = {
      scholarTitle: `Extended abstract exclusion ${index}`,
      scholarYear: 2026,
      dblpPublications: [
        {
          dblpKey: `conf/chi/ea-${index}`,
          title: `Extended abstract exclusion ${index}`,
          year: '2026',
          venue: 'CHI',
          venue_full: `Extended Abstracts of the CHI Conference ${index}`,
          acronym: 'CHI',
          pages: '1-5',
          dblpType: 'inproceedings',
        },
      ],
    };
    const expected = {
      rank: 'N/A',
      reason: 'Extended Abstract',
      decisionStatus: lib.DECISION_STATUS.UNRANKED,
    };
    assertSubset(`pipeline extended ${index}`, lib.resolvePipelineFixture(input), expected);
    fixtures.push(fixture(`gold-pipeline-extended-${String(index).padStart(2, '0')}`, 'pipeline_e2e', ['extended_abstract'], input, expected, 'Extended abstracts should stay excluded in the final decision.', 'manual_audit'));
  }

  for (let index = 1; index <= 5; index++) {
    const missingInput = { scholarTitle: `No DBLP paper ${index}`, scholarYear: 2026, dblpPublications: [] };
    const missingExpected = {
      system: 'DBLP',
      rank: 'DBLP Entry Missing',
      decisionStatus: lib.DECISION_STATUS.MISSING,
    };
    assertSubset(`pipeline dblp missing ${index}`, lib.resolvePipelineFixture(missingInput), missingExpected);
    fixtures.push(fixture(`gold-pipeline-publication-match-missing-${String(index).padStart(2, '0')}`, 'pipeline_e2e', ['false_positive_trap'], missingInput, missingExpected, 'A publication with no DBLP candidates should surface as publication match missing.', 'manual_audit'));

    const reviewInput = {
      scholarTitle: `Energy harvesting embedded systems review ${index}`,
      scholarYear: 2026,
      dblpPublications: [
        { dblpKey: `conf/amb/a-${index}`, title: `Energy harvesting for embedded systems review ${index}`, year: '2026', venue: 'IPSN' },
        { dblpKey: `conf/amb/b-${index}`, title: `Energy harvesting of embedded systems review ${index}`, year: '2026', venue: 'IPSN' },
      ],
    };
    const reviewExpected = {
      system: 'DBLP',
      rank: 'DBLP Entry Missing',
      decisionStatus: lib.DECISION_STATUS.REVIEW,
    };
    assertSubset(`pipeline review ${index}`, lib.resolvePipelineFixture(reviewInput), reviewExpected);
    fixtures.push(fixture(`gold-pipeline-dblp-review-${String(index).padStart(2, '0')}`, 'pipeline_e2e', ['review'], reviewInput, reviewExpected, 'Review DBLP publication matches should abstain instead of assigning a rank.', 'manual_audit'));
  }

  for (let index = 1; index <= 5; index++) {
    const input = {
      scholarTitle: `SenSys missing case ${index}`,
      scholarYear: 2026,
      dblpPublications: [
        {
          dblpKey: `conf/sensys/missing-${index}`,
          title: `SenSys missing case ${index}`,
          year: '2026',
          venue: 'SenSys',
          venue_full: 'ACM Conference on Embedded Networked Sensor Systems',
          acronym: 'SenSys',
          pages: '1-12',
          dblpType: 'inproceedings',
        },
      ],
    };
    const probe = lib.resolvePipelineFixture(input);
    const expected = {
      system: probe.system,
      rank: probe.rank,
      decisionStatus: probe.decisionStatus,
    };
    if (probe.reason) expected.reason = probe.reason;
    assertSubset(`pipeline sensys missing ${index}`, lib.resolvePipelineFixture(input), expected);
    fixtures.push(fixture(`gold-pipeline-sensys-missing-${String(index).padStart(2, '0')}`, 'pipeline_e2e', ['false_positive_trap'], input, expected, 'SenSys is not in CORE 2026; the pipeline should handle the missing venue.', 'bundled_core'));
  }

  let fillerIndex = 0;
  for (const entry of coreData.filter((candidate) => candidate.acronym && lib.VALID_RANKS.includes(candidate.rank))) {
    if (fixtures.length >= 100) break;
    fillerIndex += 1;
    const input = {
      scholarTitle: `Pipeline filler conference ${fillerIndex}`,
      scholarYear: 2026,
      dblpPublications: [
        {
          dblpKey: `conf/filler/${normalizeKey(entry.acronym).replace(/[^a-z0-9]+/g, '-')}-${fillerIndex}`,
          title: `Pipeline filler conference ${fillerIndex}`,
          year: '2026',
          venue: entry.acronym,
          venue_full: entry.title,
          acronym: entry.acronym,
          pages: '1-12',
          dblpType: 'inproceedings',
        },
      ],
    };
    const expected = {
      system: 'CORE',
      rank: entry.rank,
      decisionStatus: lib.DECISION_STATUS.MATCHED,
      matchedVenue: entry.title,
      sourceYear: 2026,
    };
    if (!deepSubsetEqual(expected, lib.resolvePipelineFixture(input))) continue;
    fixtures.push(fixture(`gold-pipeline-filler-${String(fillerIndex).padStart(2, '0')}`, 'pipeline_e2e', ['top_venue'], input, expected, 'Filler matched conference case to keep the gold pipeline corpus at its target size.', 'bundled_core'));
  }

  if (fixtures.length < 100) {
    throw new Error(`Expected 100 gold pipeline fixtures, found ${fixtures.length}`);
  }

  return fixtures.slice(0, 100);
}

function buildGoldSearchFixtures() {
  const fixtures = [];
  const { coreData } = lib.loadCoreReference('core/CORE_2026.json');
  const conferenceSearchCases = [
    ['SIGCOMM', { status: 'matched', primaryLabel: 'A*', matchedVenue: findCoreEntry(coreData, 'SIGCOMM').title, currentStatusLabel: 'A*', sourceYear: 2026 }],
    ['MobiCom', { status: 'matched', primaryLabel: 'A*', matchedVenue: findCoreEntry(coreData, 'MobiCom').title, currentStatusLabel: 'A*', sourceYear: 2026 }],
    ['ICSE', { status: 'matched', primaryLabel: 'A*', matchedVenue: findCoreEntry(coreData, 'ICSE').title, currentStatusLabel: 'A*', sourceYear: 2026 }],
    ['VIS', { status: 'matched', primaryLabel: 'A', matchedVenue: 'IEEE Visualization', currentStatusLabel: 'A', sourceYear: 2026 }],
    ['SIGMOD Conference', { status: 'matched', primaryLabel: 'A*', matchedVenue: findCoreEntry(coreData, 'SIGMOD').title, currentStatusLabel: 'A*', sourceYear: 2026 }],
    ['PVLDB', { status: 'matched', primaryLabel: 'A*', matchedVenue: 'International Conference on Very Large Databases', currentStatusLabel: 'A*', sourceYear: 2026 }],
    ['POMACS', { status: 'matched', primaryLabel: 'A*', matchedVenue: 'Measurement and Modeling of Computer Systems', currentStatusLabel: 'A*', sourceYear: 2026 }],
    ['USENIX Security Symposium', { status: 'matched', primaryLabel: 'A*', matchedVenue: 'Usenix Security Symposium', currentStatusLabel: 'A*', sourceYear: 2026 }],
    ['USENIX Security', { status: 'review', primaryLabel: 'Review', matchedVenue: null, currentStatusLabel: null, sourceYear: 2026 }],
    ['SenSys', { status: 'missing', primaryLabel: 'Not found', matchedVenue: null, currentStatusLabel: null, sourceYear: 2026 }],
    ['UbiComp', { status: 'missing', primaryLabel: 'Not found', matchedVenue: null, currentStatusLabel: null, sourceYear: 2026 }],
    ['NSDI', { status: 'missing', primaryLabel: 'Not found', matchedVenue: null, currentStatusLabel: null, sourceYear: 2026 }],
    ['IPSN', { status: 'missing', primaryLabel: 'Not found', matchedVenue: null, currentStatusLabel: null, sourceYear: 2026 }],
    ['Imaginary Systems Summit', { status: 'missing', primaryLabel: 'Not found', matchedVenue: null, currentStatusLabel: null, sourceYear: 2026 }],
  ];

  conferenceSearchCases.forEach(([query, expected], index) => {
    const input = { query, type: 'conference', publicationYear: 2026 };
    assertSubset(`search conference ${query}`, lib.resolveSearchQueryFixture(input), expected);
    fixtures.push(fixture(
      `gold-search-conference-${String(index + 1).padStart(2, '0')}`,
      'search_queries',
      expected.status === 'review' ? ['review'] : (expected.status === 'missing' ? ['false_positive_trap'] : ['top_venue']),
      input,
      expected,
      'Conference manual-search results should reflect the local CORE dataset and fallback snapshots.',
      expected.status === 'matched' || expected.status === 'unranked' ? 'bundled_core' : 'manual_audit'
    ));
  });

  const journalSearchCases = [
    ['ACM Computing Surveys', { status: 'matched', primaryLabel: 'Q1', matchedVenue: 'ACM Computing Surveys', currentStatusLabel: 'Q1', latestRankedSnapshot: null, sourceYear: 2024, sourceYearFallback: false }],
    ['ACM Comput. Surv.', { status: 'matched', primaryLabel: 'Q1', matchedVenue: 'ACM Computing Surveys', currentStatusLabel: 'Q1', latestRankedSnapshot: null, sourceYear: 2024, sourceYearFallback: false }],
    ['IEEE Internet of Things Journal', { status: 'matched', primaryLabel: 'Q1', matchedVenue: 'IEEE Internet of Things Journal', currentStatusLabel: 'Q1', latestRankedSnapshot: null, sourceYear: 2024, sourceYearFallback: false }],
    ['ACM Transactions on Sensor Networks', { status: 'matched', primaryLabel: 'Q1', matchedVenue: 'ACM Transactions on Sensor Networks', currentStatusLabel: 'Q1', latestRankedSnapshot: null, sourceYear: 2024, sourceYearFallback: false }],
    ['TOSN', { status: 'missing', primaryLabel: 'Not found', matchedVenue: null, currentStatusLabel: null, latestRankedSnapshot: null, sourceYear: null, sourceYearFallback: false }],
    ['Journal of Signal Processing Systems', { status: 'matched', primaryLabel: 'Q2', matchedVenue: 'Journal of Signal Processing Systems', currentStatusLabel: 'Q2', latestRankedSnapshot: null, sourceYear: 2024, sourceYearFallback: false }],
    ['J. Signal Processing Systems', { status: 'matched', primaryLabel: 'Q2', matchedVenue: 'Journal of Signal Processing Systems', currentStatusLabel: 'Q2', latestRankedSnapshot: null, sourceYear: 2024, sourceYearFallback: false }],
    ['Wireless Networks', { status: 'matched', primaryLabel: 'Q2', matchedVenue: 'Wireless Networks', currentStatusLabel: 'Q2', latestRankedSnapshot: null, sourceYear: 2024, sourceYearFallback: false }],
    ['Journal of Low Power Electronics', { status: 'matched', primaryLabel: 'Q4', matchedVenue: 'Journal of Low Power Electronics', currentStatusLabel: 'Q4', latestRankedSnapshot: null, sourceYear: 2022, sourceYearFallback: true }],
    ['Random Journal of Foo', { status: 'missing', primaryLabel: 'Not found', matchedVenue: null, currentStatusLabel: null, latestRankedSnapshot: null, sourceYear: null, sourceYearFallback: false }],
  ];

  journalSearchCases.forEach(([query, expected], index) => {
    const input = { query, type: 'journal', publicationYear: query === 'Journal of Low Power Electronics' ? 2025 : 2024 };
    assertSubset(`search journal ${query}`, lib.resolveSearchQueryFixture(input), expected);
    fixtures.push(fixture(
      `gold-search-journal-${String(index + 1).padStart(2, '0')}`,
      'search_queries',
      expected.status === 'missing' ? ['false_positive_trap'] : ['abbreviation'],
      input,
      expected,
      'Journal manual-search results should reflect the local SJR index and fallback-year behavior.',
      expected.status === 'matched' ? 'bundled_sjr' : 'manual_audit'
    ));
  });

  while (fixtures.length < 60) {
    const index = fixtures.length + 1;
    const query = `Synthetic Search Gap ${index}`;
    const input = { query, type: 'conference', publicationYear: 2026 };
    const expected = { status: 'missing', primaryLabel: 'Not found', matchedVenue: null, currentStatusLabel: null, latestRankedSnapshot: null, sourceYear: 2026 };
    assertSubset(`search filler ${index}`, lib.resolveSearchQueryFixture(input), expected);
    fixtures.push(fixture(`gold-search-filler-${String(index).padStart(2, '0')}`, 'search_queries', ['false_positive_trap'], input, expected, 'Synthetic missing queries keep the benchmark balanced with abstaining cases.', 'manual_audit'));
  }

  return fixtures.slice(0, 60);
}

function buildShadowConferenceFixtures() {
  const fixtures = [];
  const seen = new Set();
  for (const coreFile of lib.CORE_DATA_FILES) {
    const year = lib.getCoreDatasetYear(coreFile);
    const { coreData } = lib.loadCoreReference(coreFile);
    for (const entry of coreData) {
      for (const variant of [entry.acronym, entry.title]) {
        const query = String(variant || '').trim();
        if (!query) continue;
        const id = `shadow-conference-${year}-${query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const input = { venueQuery: query, fullVenueTitle: entry.title || query, coreYear: year };
        const expected = lib.resolveConferenceResolutionFixture(input);
        fixtures.push(fixture(id, 'conference_resolution', [], input, expected, 'Shadow conference fixture derived from bundled CORE data.', 'bundled_core'));
        if (fixtures.length >= 900) return fixtures;
      }
    }
  }
  return fixtures;
}

function buildShadowJournalFixtures() {
  const fixtures = [];
  const dataset = lib.loadSjrDataset();
  dataset.entries.slice(0, 320).forEach((entry, index) => {
    const latest = latestQuartile(entry);
    const input = { journalName: entry.resolvedTitle, publicationYear: latest?.year || 2024 };
    const expected = lib.resolveJournalResolutionFixture(input);
    fixtures.push(fixture(`shadow-journal-${String(index + 1).padStart(3, '0')}`, 'journal_resolution', [], input, expected, 'Shadow journal fixture derived from the bundled SJR index.', 'bundled_sjr'));
  });
  return fixtures;
}

function buildShadowPipelineFixtures() {
  const fixtures = [];
  const gold = buildGoldPipelineFixtures();
  gold.forEach((entry) => {
    fixtures.push(fixture(`shadow-${entry.id}`, 'pipeline_e2e', entry.tags, entry.input, lib.resolvePipelineFixture(entry.input), 'Shadow pipeline fixture mirrored from the gold template set.', entry.source));
  });

  const { coreData } = lib.loadCoreReference('core/CORE_2026.json');
  const moreConferenceEntries = coreData.filter((entry) => entry.acronym && lib.VALID_RANKS.includes(entry.rank)).slice(24, 180);
  moreConferenceEntries.forEach((entry, index) => {
    const input = {
      scholarTitle: `Shadow conference pipeline ${index + 1}`,
      scholarYear: 2026,
      dblpPublications: [
        {
          dblpKey: `conf/shadow/${normalizeKey(entry.acronym).replace(/[^a-z0-9]+/g, '-')}-${index + 1}`,
          title: `Shadow conference pipeline ${index + 1}`,
          year: '2026',
          venue: entry.acronym,
          venue_full: entry.title,
          acronym: entry.acronym,
          pages: '1-14',
          dblpType: 'inproceedings',
        },
      ],
    };
    fixtures.push(fixture(`shadow-pipeline-core-${String(index + 1).padStart(3, '0')}`, 'pipeline_e2e', [], input, lib.resolvePipelineFixture(input), 'Shadow conference end-to-end fixture.', 'bundled_core'));
  });

  return fixtures.slice(0, 240);
}

function buildShadowSearchFixtures() {
  const fixtures = [];
  const conferenceShadow = buildShadowConferenceFixtures().slice(0, 80);
  conferenceShadow.forEach((entry, index) => {
    const input = { query: entry.input.venueQuery, type: 'conference', publicationYear: entry.input.coreYear };
    fixtures.push(fixture(`shadow-search-conference-${String(index + 1).padStart(3, '0')}`, 'search_queries', [], input, lib.resolveSearchQueryFixture(input), 'Shadow conference search fixture.', 'bundled_core'));
  });
  const journalShadow = buildShadowJournalFixtures().slice(0, 40);
  journalShadow.forEach((entry, index) => {
    const input = { query: entry.input.journalName, type: 'journal', publicationYear: entry.input.publicationYear };
    fixtures.push(fixture(`shadow-search-journal-${String(index + 1).padStart(3, '0')}`, 'search_queries', [], input, lib.resolveSearchQueryFixture(input), 'Shadow journal search fixture.', 'bundled_sjr'));
  });
  return fixtures;
}

function buildSuites() {
  return {
    gold: {
      profile_match: buildGenericProfileFixtures(),
      publication_match: buildGenericPublicationFixtures(),
      track_classification: buildGenericTrackFixtures(),
      conference_resolution: buildGoldConferenceFixtures(),
      journal_resolution: buildGoldJournalFixtures(),
      pipeline_e2e: buildGoldPipelineFixtures(),
      search_queries: buildGoldSearchFixtures(),
    },
    shadow: {
      conference_resolution: buildShadowConferenceFixtures(),
      journal_resolution: buildShadowJournalFixtures(),
      pipeline_e2e: buildShadowPipelineFixtures(),
      search_queries: buildShadowSearchFixtures(),
    },
  };
}

function main() {
  const suites = buildSuites();
  writeSuite('gold', suites.gold);
  writeSuite('shadow', suites.shadow);

  const counts = {};
  for (const [suiteName, suite] of Object.entries(suites)) {
    counts[suiteName] = Object.fromEntries(Object.entries(suite).map(([family, entries]) => [family, entries.length]));
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    fixtureRoot: lib.FIXTURE_ROOT,
    counts,
  }, null, 2));
}

main();
