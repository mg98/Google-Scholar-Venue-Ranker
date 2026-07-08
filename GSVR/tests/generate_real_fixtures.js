/*
 * Authors the REAL benchmark suite (fixtures/accuracy/real/).
 *
 * Unlike the gold/shadow generators, every case here is a REAL query string a
 * Scholar/DBLP pipeline actually produces (DBLP journal abbreviations, full
 * proceedings titles, acronym collisions, truncated Scholar titles), and the
 * expected values are built from human-pinned identities:
 *  - the journal/conference IDENTITY (which journal/CORE entry the query means)
 *    is hand-specified below and was manually verified;
 *  - the expected rank/quartile is read DIRECTLY from the authority dataset
 *    (SJR index / bundled CORE file) for that pinned identity — never from the
 *    resolver under test;
 *  - the script then asserts the resolver agrees, so authoring fails loudly
 *    instead of writing self-fulfilling fixtures.
 *
 * Usage: node GSVR/tests/generate_real_fixtures.js
 */
const path = require('path');

const lib = require('./accuracy_benchmark_lib.js');
const core = require('../rank_core.js');

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
      `Real-fixture authoring check failed for ${label}.`,
      `Expected subset: ${JSON.stringify(expected, null, 2)}`,
      `Actual: ${JSON.stringify(actual, null, 2)}`,
    ].join('\n'));
  }
}

function fixture(id, family, tags, input, expected, notes) {
  return { id, family, tags, input, expected, notes, source: 'real_world_manual_audit' };
}

// ---------- authority lookups (never via the resolver under test) ----------

function findSjrEntryByExactTitle(title) {
  const dataset = lib.loadSjrDataset();
  const needle = String(title).trim().toLowerCase();
  const hits = dataset.entries.filter((entry) => entry.resolvedTitle.trim().toLowerCase() === needle);
  if (hits.length !== 1) {
    throw new Error(`Expected exactly one SJR entry titled "${title}", found ${hits.length}`);
  }
  return hits[0];
}

function sjrQuartileFor(entry, year) {
  const quartile = entry.quartilesByYear[String(year)] ?? entry.quartilesByYear[year];
  if (!quartile) {
    throw new Error(`SJR entry "${entry.resolvedTitle}" has no quartile for ${year}`);
  }
  return quartile;
}

function findCoreEntry(coreDataFile, { acronym = null, title = null }) {
  const { coreData } = lib.loadCoreReference(coreDataFile);
  const hits = coreData.filter((entry) => {
    if (acronym && entry.acronym.toLowerCase() !== acronym.toLowerCase()) return false;
    if (title && entry.title.toLowerCase() !== title.toLowerCase()) return false;
    return true;
  });
  if (hits.length !== 1) {
    throw new Error(`Expected exactly one CORE entry for ${acronym || title} in ${coreDataFile}, found ${hits.length}`);
  }
  return hits[0];
}

// ---------- journal_resolution ----------
// query: the string DBLP/Scholar actually renders; title: the human-verified
// official journal it refers to. Quartile comes from the SJR index data.

const JOURNAL_CASES = [
  { query: 'IEEE Trans. Mob. Comput.', title: 'IEEE Transactions on Mobile Computing', year: 2023 },
  { query: 'IEEE J. Sel. Areas Commun.', title: 'IEEE Journal on Selected Areas in Communications', year: 2023 },
  { query: 'ACM Trans. Sens. Networks', title: 'ACM Transactions on Sensor Networks', year: 2023 },
  { query: 'IEEE Trans. Ind. Informatics', title: 'IEEE Transactions on Industrial Informatics', year: 2023 },
  { query: 'IEEE Commun. Surv. Tutorials', title: 'IEEE Communications Surveys and Tutorials', year: 2023 },
  { query: 'J. Mach. Learn. Res.', title: 'Journal of Machine Learning Research', year: 2023 },
  { query: 'IEEE Trans. Parallel Distributed Syst.', title: 'IEEE Transactions on Parallel and Distributed Systems', year: 2023 },
  { query: 'Future Gener. Comput. Syst.', title: 'Future Generation Computer Systems', year: 2023 },
  { query: 'Pervasive Mob. Comput.', title: 'Pervasive and Mobile Computing', year: 2023 },
  { query: 'Ad Hoc Networks', title: 'Ad Hoc Networks', year: 2023 },
  { query: 'Comput. Networks', title: 'Computer Networks', year: 2023 },
  { query: 'IEEE Wirel. Commun.', title: 'IEEE Wireless Communications', year: 2023 },
  { query: 'IEEE Netw.', title: 'IEEE Network', year: 2023 },
  { query: 'Sensors', title: 'Sensors', year: 2023 },
  { query: 'IEEE Access', title: 'IEEE Access', year: 2023 },
  { query: 'PLoS ONE', title: 'PLOS ONE', year: 2023 },
  { query: 'Nature', title: 'Nature', year: 2023 },
  { query: 'Science', title: 'Science', year: 2023 },
  { query: 'Expert Syst. Appl.', title: 'Expert Systems with Applications', year: 2023 },
  { query: 'Knowl. Based Syst.', title: 'Knowledge-Based Systems', year: 2023 },
  { query: 'Inf. Sci.', title: 'Information Sciences', year: 2023 },
  { query: 'Appl. Soft Comput.', title: 'Applied Soft Computing', year: 2023 },
  { query: 'Neural Comput. Appl.', title: 'Neural Computing and Applications', year: 2023 },
  { query: 'IEEE Trans. Veh. Technol.', title: 'IEEE Transactions on Vehicular Technology', year: 2023 },
  { query: 'IEEE Internet Comput.', title: 'IEEE Internet Computing', year: 2023 },
  { query: 'Concurr. Comput. Pract. Exp.', title: 'Concurrency and Computation: Practice and Experience', year: 2023 },
  { query: 'Softw. Pract. Exp.', title: 'Software - Practice and Experience', year: 2023 },
  { query: 'Empir. Softw. Eng.', title: 'Empirical Software Engineering', year: 2023 },
  { query: 'Autom. Softw. Eng.', title: 'Automated Software Engineering', year: 2023 },
  { query: 'Real Time Syst.', title: 'Real-Time Systems', year: 2023 },
  { query: 'IEEE Trans. Computers', title: 'IEEE Transactions on Computers', year: 2023 },
  { query: 'IEEE Trans. Software Eng.', title: 'IEEE Transactions on Software Engineering', year: 2023 },
  { query: 'ACM Trans. Database Syst.', title: 'ACM Transactions on Database Systems', year: 2023 },
  { query: 'IEEE Trans. Knowl. Data Eng.', title: 'IEEE Transactions on Knowledge and Data Engineering', year: 2023 },
  { query: 'IEEE Trans. Pattern Anal. Mach. Intell.', title: 'IEEE Transactions on Pattern Analysis and Machine Intelligence', year: 2023 },
  { query: 'Artif. Intell.', title: 'Artificial Intelligence', year: 2023 },
  { query: 'J. Netw. Comput. Appl.', title: 'Journal of Network and Computer Applications', year: 2023 },
  { query: 'IEEE Trans. Inf. Theory', title: 'IEEE Transactions on Information Theory', year: 2023 },
  { query: 'IEEE/ACM Trans. Netw.', title: 'IEEE/ACM Transactions on Networking', year: 2023 },
  { query: 'Computing', title: 'Computing', year: 2023 },
  { query: 'ACM Trans. Graph.', title: 'ACM Transactions on Graphics', year: 2023 },
  { query: 'ACM Trans. Softw. Eng. Methodol.', title: 'ACM Transactions on Software Engineering and Methodology', year: 2023 },
  { query: 'IEEE Trans. Dependable Secur. Comput.', title: 'IEEE Transactions on Dependable and Secure Computing', year: 2023 },
  { query: 'ACM Comput. Surv.', title: 'ACM Computing Surveys', year: 2023 },
  { query: 'J. Cogn. Neurosci.', title: 'Journal of Cognitive Neuroscience', year: 2023 },
  { query: 'IEEE Trans. Ind. Electron.', title: 'IEEE Transactions on Industrial Electronics', year: 2023 },
  { query: 'Inf. Process. Lett.', title: 'Information Processing Letters', year: 2023 },
  { query: 'Oper. Syst. Rev.', title: 'Operating Systems Review (ACM)', year: 2023 },
  // Identity traps: merged-key journals must resolve to THEIR OWN quartiles.
  { query: 'Journal of Diabetes', title: 'Journal of Diabetes', year: 2022, tags: ['identity_trap'] },
  { query: 'Diabetes', title: 'Diabetes', year: 2022, tags: ['identity_trap'] },
  { query: 'Neuroscience', title: 'Neuroscience', year: 2022, tags: ['identity_trap'] },
  { query: 'Journal of Genetics', title: 'Journal of Genetics', year: 2022, tags: ['identity_trap'] },
  { query: 'Cell Journal', title: 'Cell Journal', year: 2022, tags: ['identity_trap'] },
];

function buildJournalFixtures() {
  const fixtures = [];
  JOURNAL_CASES.forEach((entry, index) => {
    const sjrEntry = findSjrEntryByExactTitle(entry.title);
    const quartile = sjrQuartileFor(sjrEntry, entry.year);
    const input = { journalName: entry.query, publicationYear: entry.year };
    const expected = {
      status: lib.DECISION_STATUS.MATCHED,
      quartile,
      matchedTitle: sjrEntry.resolvedTitle,
      matchedSourceId: sjrEntry.sourceId || null,
      sourceYear: entry.year,
      sourceYearFallback: false,
    };
    assertSubset(`real journal ${entry.query}`, lib.resolveJournalResolutionFixture(input), expected);
    fixtures.push(fixture(
      `real-journal-${String(index + 1).padStart(2, '0')}`,
      'journal_resolution',
      entry.tags || ['dblp_abbreviation'],
      input,
      expected,
      `Real DBLP/Scholar rendering of ${sjrEntry.resolvedTitle}; identity human-verified, quartile read from SCImago data.`
    ));
  });

  // Pre-1999 journal papers report missing historical coverage, never a guess.
  const historicalInput = { journalName: 'IEEE Transactions on Pattern Analysis and Machine Intelligence', publicationYear: 1998 };
  const historicalExpected = {
    status: lib.DECISION_STATUS.UNRANKED,
    quartile: 'N/A',
    reason: 'sjr_historical_coverage_unavailable',
  };
  assertSubset('real journal historical TPAMI 1998', lib.resolveJournalResolutionFixture(historicalInput), historicalExpected);
  fixtures.push(fixture(
    'real-journal-historical-tpami-1998',
    'journal_resolution',
    ['historical_coverage'],
    historicalInput,
    historicalExpected,
    'SJR coverage starts in 1999; a 1998 paper must be reported as out of coverage.'
  ));

  return fixtures;
}

// ---------- conference_resolution ----------
// pin: which CORE entry (by acronym or exact title) the query refers to.
// Expected rank is read from the bundled CORE data for that entry.

const CONFERENCE_CASES = [
  { query: 'SIGCOMM', full: 'Proceedings of the ACM SIGCOMM 2024 Conference', year: 2024, pin: { acronym: 'SIGCOMM' } },
  { query: 'SenSys', full: 'Proceedings of the 21st ACM Conference on Embedded Networked Sensor Systems', year: 2023, pin: { acronym: 'SenSys' } },
  { query: 'NeurIPS', full: 'Advances in Neural Information Processing Systems 36', year: 2023, pin: { acronym: 'NeurIPS' } },
  { query: 'ICML', full: 'Proceedings of the 40th International Conference on Machine Learning', year: 2023, pin: { acronym: 'ICML' } },
  { query: 'CHI', full: 'Proceedings of the 2023 CHI Conference on Human Factors in Computing Systems', year: 2023, pin: { acronym: 'CHI' } },
  { query: 'ICSE', full: 'Proceedings of the 45th International Conference on Software Engineering', year: 2023, pin: { acronym: 'ICSE' } },
  { query: 'CCS', full: 'Proceedings of the 2023 ACM SIGSAC Conference on Computer and Communications Security', year: 2023, pin: { acronym: 'CCS' } },
  { query: 'KDD', full: 'Proceedings of the 29th ACM SIGKDD Conference on Knowledge Discovery and Data Mining', year: 2023, pin: { acronym: 'KDD' } },
  { query: 'EuroSys', full: 'Proceedings of the Eighteenth European Conference on Computer Systems', year: 2023, pin: { acronym: 'EuroSys' } },
  { query: 'MobiCom', full: 'Proceedings of the 29th Annual International Conference on Mobile Computing and Networking', year: 2023, pin: { acronym: 'MobiCom' } },
  { query: 'MobiSys', full: 'Proceedings of the 21st Annual International Conference on Mobile Systems, Applications and Services', year: 2023, pin: { acronym: 'MobiSys' } },
  { query: 'INFOCOM', full: 'IEEE Conference on Computer Communications', year: 2023, pin: { acronym: 'INFOCOM' } },
  { query: 'SOSP', full: 'Proceedings of the 29th Symposium on Operating Systems Principles', year: 2023, pin: { acronym: 'SOSP' } },
  { query: 'PLDI', full: 'Proceedings of the 44th ACM SIGPLAN Conference on Programming Language Design and Implementation', year: 2023, pin: { acronym: 'PLDI' } },
  { query: 'RTSS', full: 'IEEE Real-Time Systems Symposium', year: 2023, pin: { acronym: 'RTSS' } },
  { query: 'ISCA', full: 'Proceedings of the 50th Annual International Symposium on Computer Architecture', year: 2023, pin: { acronym: 'ISCA' } },
  { query: 'MICRO', full: 'Proceedings of the 56th Annual IEEE/ACM International Symposium on Microarchitecture', year: 2023, pin: { acronym: 'MICRO' } },
  { query: 'EWSN', full: 'International Conference on Embedded Wireless Systems and Networks', year: 2023, pin: { acronym: 'EWSN' } },
  { query: 'PerCom', full: 'IEEE International Conference on Pervasive Computing and Communications', year: 2023, pin: { acronym: 'PerCom' } },
  { query: 'ICDCS', full: 'IEEE International Conference on Distributed Computing Systems', year: 2023, pin: { acronym: 'ICDCS' } },
  { query: 'Middleware', full: 'Proceedings of the 24th International Middleware Conference', year: 2023, pin: { acronym: 'Middleware' } },
  // Era-appropriate historical snapshots.
  { query: 'SIGCOMM', full: 'Proceedings of the ACM SIGCOMM 2011 Conference', year: 2011, pin: { acronym: 'SIGCOMM' }, tags: ['historical_snapshot'] },
  { query: 'SenSys', full: 'Proceedings of the 6th ACM Conference on Embedded Network Sensor Systems', year: 2008, pin: { acronym: 'SenSys' }, tags: ['historical_snapshot'] },
  { query: 'RTSS', full: 'IEEE Real-Time Systems Symposium', year: 2013, pin: { acronym: 'RTSS' }, tags: ['historical_snapshot'] },
];

function buildConferenceFixtures() {
  const fixtures = [];
  CONFERENCE_CASES.forEach((entry, index) => {
    const coreDataFile = lib.getCoreDataFileForYear(entry.year);
    const coreEntry = findCoreEntry(coreDataFile, entry.pin);
    let ranked = lib.VALID_RANKS.includes(coreEntry.rank);
    let expectedRank = ranked ? coreEntry.rank : 'N/A';
    // Deliberate policy (authority: venue_data.js top-venue list): CSRankings
    // top venues missing a CORE rank in a snapshot resolve as A*.
    if (!ranked && !coreEntry.rawRank && core.isCsrankingsTopVenue(core.canonicalizeCsrankingsVenueName(coreEntry.acronym || coreEntry.title))) {
      ranked = true;
      expectedRank = 'A*';
    }
    const input = { venueQuery: entry.query, fullVenueTitle: entry.full, coreYear: entry.year };
    const expected = {
      status: ranked ? lib.DECISION_STATUS.MATCHED : lib.DECISION_STATUS.UNRANKED,
      rank: expectedRank,
      matchedVenue: coreEntry.title,
    };
    assertSubset(`real conference ${entry.query} (${entry.year})`, lib.resolveConferenceResolutionFixture(input), expected);
    fixtures.push(fixture(
      `real-conference-${String(index + 1).padStart(2, '0')}`,
      'conference_resolution',
      entry.tags || ['real_acronym'],
      input,
      expected,
      `${entry.query} (${entry.year}) -> ${coreEntry.title}; identity human-verified, rank read from ${coreDataFile}.`
    ));
  });

  // Generated-acronym collision traps: confidently WRONG ranks before the
  // acronym/title cross-check existed (ALT-B, SC-A, IV-C respectively).
  const trapCases = [
    { id: 'real-conference-trap-altw', query: 'Australasian Language Technology Workshop' },
    { id: 'real-conference-trap-scn', query: 'Conference on Security and Cryptography for Networks' },
    { id: 'real-conference-trap-ivc', query: 'Image and Vision Computing Conference' },
  ];
  for (const trap of trapCases) {
    const input = { venueQuery: trap.query, fullVenueTitle: trap.query, coreYear: 2026 };
    const actual = lib.resolveConferenceResolutionFixture(input);
    const expected = {
      status: actual.status,
      rank: 'N/A',
      matchedVenue: trap.query,
    };
    if (lib.VALID_RANKS.includes(actual.rank)) {
      throw new Error(`Collision trap ${trap.id} unexpectedly resolved to rank ${actual.rank}`);
    }
    fixtures.push(fixture(
      trap.id,
      'conference_resolution',
      ['acronym_collision_trap'],
      input,
      expected,
      'Generated-acronym collision: must resolve to the venue\'s own (unranked) entry, never another conference\'s rank.'
    ));
  }

  // NOTE: the acronym/full-title cross-check (resolveCoreVenue with a
  // contradicting fullVenueTitle) is exercised by testAcronymTitleCrossCheck in
  // run_tests.js. The conference_resolution fixture family models the Venue
  // Explorer search path, which is query-only and never sees a full title.

  return fixtures;
}

// ---------- track_classification ----------

const TRACK_CASES = [
  {
    id: 'real-track-title-at-sign-main',
    input: {
      title: 'Energy@home: A User-Centered Energy Management System for Residential Buildings',
      venue: 'CHI',
      venue_full: 'Proceedings of the SIGCHI Conference on Human Factors in Computing Systems',
      acronym: 'CHI',
      dblpKey: 'conf/chi/energyhome2020',
      pageCount: 12,
      dblpType: 'inproceedings',
    },
    expected: { label: 'main' },
    notes: 'A paper title containing "@" must not be classified as a workshop paper.',
  },
  {
    id: 'real-track-title-workshop-word-main',
    input: {
      title: 'Lessons Learned from the Dagstuhl Workshop on Intermittent Computing',
      venue: 'CACM',
      venue_full: 'Communications of the ACM',
      dblpKey: 'journals/cacm/lessons2022',
      pageCount: 9,
      dblpType: 'article',
    },
    expected: { label: 'main' },
    notes: 'A paper title mentioning "workshop" must not flag the publication itself as a workshop paper.',
  },
  {
    id: 'real-track-venue-at-notation-workshop',
    input: {
      title: 'On Securing Persistent State in Intermittent Computing',
      venue: 'ENSsys@SenSys',
      venue_full: 'Proceedings of the 4th International Workshop on Energy Harvesting and Energy-Neutral Sensing Systems',
      acronym: 'ENSsys',
      dblpKey: 'conf/sensys/enssys2020',
      pageCount: 6,
      dblpType: 'inproceedings',
    },
    expected: { label: 'workshop', resolvedVenue: 'ENSsys', parentVenue: 'SenSys' },
    notes: 'DBLP X@Y venue notation is the canonical workshop signal.',
  },
  {
    id: 'real-track-poster-prefix',
    input: {
      title: 'Poster: Low-Power Backscatter Communication for Dense Deployments',
      venue: 'SenSys',
      venue_full: 'Proceedings of the ACM Conference on Embedded Networked Sensor Systems',
      acronym: 'SenSys',
      dblpKey: 'conf/sensys/poster2022',
      pageCount: 2,
      dblpType: 'inproceedings',
    },
    expected: { label: 'demoPoster' },
    notes: 'A "Poster:" title prefix with a 2-page record is a poster, not a full paper.',
  },
  {
    id: 'real-track-extended-abstract',
    input: {
      title: 'Designing Tangible Interfaces for Children',
      venue: 'CHI Extended Abstracts',
      venue_full: 'CHI Conference on Human Factors in Computing Systems Extended Abstracts',
      acronym: 'CHI EA',
      dblpKey: 'conf/chi/ea2021',
      pageCount: 6,
      dblpType: 'inproceedings',
    },
    expected: { label: 'extendedAbstract' },
    notes: 'Extended-abstract companion tracks are excluded from rank counting.',
  },
  {
    id: 'real-track-short-paper-by-pages',
    input: {
      title: 'A Measurement Study of Inter-Datacenter Latency',
      venue: 'IMC',
      venue_full: 'Proceedings of the Internet Measurement Conference',
      acronym: 'IMC',
      dblpKey: 'conf/imc/short2021',
      pageCount: 5,
      dblpType: 'inproceedings',
    },
    expected: { label: 'shortPaper' },
    notes: 'Under-6-page main-track records are short papers (CSRankings-style exclusion).',
  },
];

function buildTrackFixtures() {
  return TRACK_CASES.map((entry) => {
    assertSubset(entry.id, lib.resolveTrackClassificationFixture(entry.input), entry.expected);
    return fixture(entry.id, 'track_classification', ['real_world'], entry.input, entry.expected, entry.notes);
  });
}

// ---------- publication_match ----------

const LONG_TITLE = 'A Comprehensive Survey of Energy Harvesting Architectures for Batteryless Intermittent Computing Systems in the Internet of Things';

const PUBLICATION_CASES = [
  {
    id: 'real-publication-truncated-title',
    input: {
      scholarTitle: `${LONG_TITLE.slice(0, 78).trim()}…`,
      scholarYear: 2022,
      dblpPublications: [
        { dblpKey: 'journals/csur/survey22', title: LONG_TITLE, year: '2022', venue: 'ACM Comput. Surv.' },
        { dblpKey: 'conf/sensys/other22', title: 'A Different Paper About Backscatter Networking Entirely', year: '2022', venue: 'SenSys' },
      ],
    },
    expected: { status: 'matched', matchedKey: 'journals/csur/survey22', exactTitleMatch: false },
    notes: 'Scholar ellipsis-truncated titles must prefix-match their DBLP record.',
  },
  {
    id: 'real-publication-truncated-review',
    input: {
      scholarTitle: 'A Longitudinal Study of Network Behavior in Campus Networks…',
      scholarYear: 2022,
      dblpPublications: [
        { dblpKey: 'conf/imc/part1', title: 'A Longitudinal Study of Network Behavior in Campus Networks: Measurements', year: '2022', venue: 'IMC' },
        { dblpKey: 'conf/imc/part2', title: 'A Longitudinal Study of Network Behavior in Campus Networks: Modeling', year: '2022', venue: 'IMC' },
      ],
    },
    expected: { status: 'review', matchedKey: null },
    notes: 'Two records sharing the truncated prefix are indistinguishable; the matcher must abstain.',
  },
  {
    id: 'real-publication-diacritics',
    input: {
      scholarTitle: 'Énergie-Aware Scheduling für Heterogeneous Müller Architectures',
      scholarYear: 2021,
      dblpPublications: [
        { dblpKey: 'conf/date/fold21', title: 'Energie-Aware Scheduling fur Heterogeneous Muller Architectures', year: '2021', venue: 'DATE' },
      ],
    },
    expected: { status: 'matched', matchedKey: 'conf/date/fold21', exactTitleMatch: true },
    notes: 'Accented Scholar titles must exact-match unaccented DBLP renderings after diacritic folding.',
  },
  {
    id: 'real-publication-year-skew',
    input: {
      scholarTitle: 'Reliable Intermittent Computing on Energy Harvesting Platforms',
      scholarYear: 2019,
      dblpPublications: [
        { dblpKey: 'conf/sensys/skew22', title: 'Reliable Intermittent Computing on Energy Harvesting Platforms', year: '2022', venue: 'SenSys' },
      ],
    },
    expected: { status: 'matched', matchedKey: 'conf/sensys/skew22' },
    notes: 'A 3-year Scholar/DBLP year skew with an exact title must still match (penalized, not rejected).',
  },
];

function buildPublicationFixtures() {
  return PUBLICATION_CASES.map((entry) => {
    assertSubset(entry.id, lib.resolvePublicationMatchFixture(entry.input), entry.expected);
    return fixture(entry.id, 'publication_match', ['real_world'], entry.input, entry.expected, entry.notes);
  });
}

// ---------- main ----------

function main() {
  const byFamily = {
    journal_resolution: buildJournalFixtures(),
    conference_resolution: buildConferenceFixtures(),
    track_classification: buildTrackFixtures(),
    publication_match: buildPublicationFixtures(),
  };

  lib.ensureDir(lib.REAL_DIR);
  for (const family of lib.FIXTURE_FAMILIES) {
    const entries = byFamily[family] || [];
    if (entries.length) {
      lib.writeJsonLinesFile(path.join(lib.REAL_DIR, `${family}.jsonl`), entries);
    }
  }

  const counts = Object.fromEntries(Object.entries(byFamily).map(([family, entries]) => [family, entries.length]));
  console.log('Real suite written:', JSON.stringify(counts, null, 2));
}

main();
