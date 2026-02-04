const assert = require('assert');

const core = require('../rank_core.js');

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
    similarityThreshold: 0.88,
    maxYearDiff: 2,
  });

  const r2 = core.selectBestDblpMatch({
    scholarTitle: 'On Securing Persistent State in Intermittent Computing',
    scholarYear: 2020,
    dblpPublications: pubs2,
    similarityThreshold: 0.88,
    maxYearDiff: 2,
  });

  assert(r1 && r2, 'Expected a match in both runs');
  assert.strictEqual(r1.dblpKey, r2.dblpKey, 'Match should not depend on input ordering');
  assert.strictEqual(r1.dblpKey, 'conf/sensys/enssys2020', 'Expected lexicographically smallest dblpKey in a tie');
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

function run() {
  testDeterministicDblpMatch();
  testWorkshopClassification();
  testDemoPosterClassification();
  testDemoKeywordNotTrackWhenPagesHigh();
  testDemoKeywordNotTrackEvenWithoutPages();
  testExtendedAbstractClassification();
  testLetterPrefixPagesParsing();
  testPlusNormalization();
  testShortPaperByPages();
  testVenueNormalization();

  console.log('All tests passed.');
}

run();
