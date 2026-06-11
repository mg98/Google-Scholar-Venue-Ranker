/*
 * Threshold tuning harness for the publication-title matcher.
 *
 * Sweeps publicationSimilarityThreshold (and the strong-similarity escape)
 * over every publication_match fixture in the gold + real suites and reports
 * the accuracy / wrong-match / abstain frontier per threshold, so future
 * threshold changes are made against measured data instead of intuition.
 *
 * A "wrong match" is a fixture where the matcher returned a DIFFERENT dblpKey
 * than expected, or matched when the fixture expects abstain/missing — the
 * precision-critical failure mode. "Lost matches" are expected matches that
 * became abstain/missing — the recall cost of a higher threshold.
 *
 * Usage: npm run tune:thresholds
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = require("../GSVR/tests/accuracy_benchmark_lib.js");
const core = require("../GSVR/rank_core.js");

const fixtures = [
  ...lib.loadFixtures({ suite: "gold", family: "publication_match" }),
  ...lib.loadFixtures({ suite: "real", family: "publication_match" }),
];

if (!fixtures.length) {
  console.error("No publication_match fixtures found. Generate fixtures first.");
  process.exit(1);
}

const DEFAULT = core.RANKING_CONFIG.publicationSimilarityThreshold;
const thresholds = [0.8, 0.82, 0.84, 0.86, 0.88, 0.9, 0.92, 0.94];

console.log(`Fixtures: ${fixtures.length} (gold + real publication_match)`);
console.log(`Current default threshold: ${DEFAULT}\n`);
console.log("threshold | correct | wrongMatch | lostMatch | spuriousAbstainOrMatch");

for (const threshold of thresholds) {
  let correct = 0;
  let wrongMatch = 0;
  let lostMatch = 0;
  let other = 0;

  for (const fixture of fixtures) {
    const result = core.selectBestDblpMatchDetailed({
      scholarTitle: fixture.input?.scholarTitle || "",
      scholarYear: Number.isFinite(fixture.input?.scholarYear) ? fixture.input.scholarYear : null,
      dblpPublications: fixture.input?.dblpPublications || [],
      similarityThreshold: threshold,
    });
    const actualStatus = result.status;
    const actualKey = result.match?.dblpKey || null;
    const expectedStatus = fixture.expected?.status;
    const expectedKey = fixture.expected?.matchedKey ?? null;

    if (expectedStatus === "matched") {
      if (actualStatus === "matched" && actualKey === expectedKey) correct++;
      else if (actualStatus === "matched") wrongMatch++;
      else lostMatch++;
    } else if (actualStatus === expectedStatus) {
      correct++;
    } else if (actualStatus === "matched") {
      wrongMatch++;
    } else {
      other++;
    }
  }

  const marker = threshold === DEFAULT ? "  <-- current default" : "";
  console.log(
    `${String(threshold).padEnd(9)} | ${String(correct).padStart(7)} | ${String(wrongMatch).padStart(10)} | ${String(lostMatch).padStart(9)} | ${String(other).padStart(6)}${marker}`
  );
}

console.log(
  "\nInterpretation: pick the highest threshold with zero wrongMatch and zero lostMatch.\n" +
  "Only change RANKING_CONFIG when this table shows a strictly better operating point\n" +
  "on a fixture set that includes real-world cases."
);
