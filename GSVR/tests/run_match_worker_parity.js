#!/usr/bin/env node
/*
 * run_match_worker_parity.js
 *
 * Verifies that the matching worker (rankings_worker.js) produces byte-identical
 * ranking decisions to the in-process production matcher. The worker loads the
 * exact same content.js via importScripts + headless shims, so any divergence
 * here means the worker environment (shims, dataset load, message protocol) is
 * broken — not the matching logic itself.
 *
 * The real browser Worker/CSP plumbing still needs a live browser to exercise,
 * but this proves the code the worker runs matches the main-thread matcher.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const INDEX_JSON = path.join(ROOT, 'data', 'rankings-index.json');
const { getProductionMatcher } = require(path.join(ROOT, 'match_cli.js'));

// --- Build a WorkerGlobalScope-like vm context that runs rankings_worker.js ---
function createWorkerHarness() {
  const outbox = [];
  const context = {
    console: { ...console, log() {}, debug() {}, info() {} },
    setTimeout,
    clearTimeout,
    performance,
    URL,
    URLSearchParams,
    Headers,
    Response,
    TextEncoder,
    TextDecoder,
    postMessage(message) { outbox.push(message); },
    fetch: async (input) => {
      const requested = String(input || '');
      const filePath = requested.endsWith('rankings-index.json') ? INDEX_JSON : requested;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() { return JSON.parse(fs.readFileSync(filePath, 'utf8')); },
        async text() { return fs.readFileSync(filePath, 'utf8'); },
        headers: { get() { return null; } },
      };
    },
    importScripts(...urls) {
      for (const url of urls) {
        const raw = String(url);
        let filePath = raw;
        if (!fs.existsSync(filePath)) {
          const tail = raw.replace(/^.*\/GSVR\//, '').replace(/^\/+/, '');
          filePath = fs.existsSync(path.join(ROOT, tail))
            ? path.join(ROOT, tail)
            : path.join(ROOT, path.basename(raw));
        }
        vm.runInContext(fs.readFileSync(filePath, 'utf8'), context, { filename: filePath });
      }
    },
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);

  // Load the worker script itself (defines the shims + self.onmessage).
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'rankings_worker.js'), 'utf8'), context, {
    filename: path.join(ROOT, 'rankings_worker.js'),
  });

  let requestSeq = 0;
  async function send(message) {
    const requestId = ++requestSeq;
    const before = outbox.length;
    await context.onmessage({
      data: { baseUrl: ROOT + '/', indexUrl: INDEX_JSON, requestId, ...message },
    });
    const reply = outbox.slice(before).find((m) => m && m.requestId === requestId);
    if (!reply) throw new Error(`worker sent no reply for request ${requestId}`);
    if (!reply.ok) throw new Error(`worker error: ${reply.error}`);
    return reply;
  }
  return { send };
}

function collectFixtureItems() {
  const items = [];
  const readJsonl = (file) => {
    const full = path.join(ROOT, 'tests', 'fixtures', 'accuracy', 'gold', file);
    if (!fs.existsSync(full)) return [];
    return fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  for (const row of readJsonl('conference_resolution.jsonl')) {
    const input = row.input || {};
    if (input.venueQuery) items.push({ venue: input.venueQuery, title: '', year: input.coreYear ?? null });
    if (input.fullVenueTitle && input.fullVenueTitle !== input.venueQuery) {
      items.push({ venue: input.fullVenueTitle, title: '', year: input.coreYear ?? null });
    }
  }
  for (const row of readJsonl('journal_resolution.jsonl')) {
    const input = row.input || {};
    if (input.journalName) items.push({ venue: input.journalName, title: '', year: input.publicationYear ?? null });
  }
  for (const row of readJsonl('search_queries.jsonl')) {
    const input = row.input || {};
    const venue = input.venueQuery || input.query || input.journalName || input.venue;
    if (venue) items.push({ venue, title: '', year: input.coreYear ?? input.publicationYear ?? null });
  }
  // A few hand-picked strings that exercise non-catalog paths.
  items.push(
    { venue: 'arXiv preprint arXiv:2101.00001', title: 'Some preprint', year: 2021 },
    { venue: 'US Patent 10,123,456', title: 'A patent', year: 2019 },
    { venue: 'Proceedings of the 2020 CHI Conference on Human Factors in Computing Systems', title: '', year: 2020 },
    { venue: 'IEEE Transactions on Pattern Analysis and Machine Intelligence', title: '', year: 2018 },
    { venue: 'International Workshop on Something Obscure', title: '', year: 2015 },
    { venue: 'Totally made up venue that matches nothing at all', title: '', year: 2011 },
  );
  // De-dupe identical (venue, year) pairs to keep the run compact.
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.venue}::${item.year}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  const matcher = getProductionMatcher({ quiet: true });
  const harness = createWorkerHarness();
  const items = collectFixtureItems();

  // Warm both matchers.
  await matcher.loadRankingsData();
  await harness.send({ type: 'warm' });

  // Worker path: rank the whole set in one batch.
  const { decisions: workerDecisions } = await harness.send({ type: 'rankBatch', items });

  // Reference path: rank each item in-process.
  const referenceDecisions = [];
  for (const item of items) {
    referenceDecisions.push(await matcher.pickVenueRanking(item.venue, item.title, item.year));
  }

  assert.strictEqual(workerDecisions.length, items.length, 'worker returned wrong count');

  let mismatches = 0;
  for (let i = 0; i < items.length; i++) {
    const worker = workerDecisions[i];
    const reference = referenceDecisions[i];
    // Structured clone (real worker boundary) drops nothing here — decisions are
    // plain data — so a JSON round-trip is a faithful stand-in for comparison.
    const workerJson = JSON.stringify(worker ?? null);
    const referenceJson = JSON.stringify(reference ?? null);
    if (workerJson !== referenceJson) {
      mismatches++;
      if (mismatches <= 10) {
        console.error(`\nMISMATCH for venue=${JSON.stringify(items[i].venue)} year=${items[i].year}`);
        console.error(`  worker:    ${workerJson}`);
        console.error(`  reference: ${referenceJson}`);
      }
    }
  }

  // Empty-venue guard: the worker must return null (content.js never sends these).
  const { decisions: emptyDecisions } = await harness.send({ type: 'rankBatch', items: [{ venue: '', title: 'x', year: 2020 }] });
  assert.strictEqual(emptyDecisions[0], null, 'worker should return null for empty venue');

  if (mismatches > 0) {
    console.error(`\nMatch worker parity FAILED: ${mismatches}/${items.length} decisions differ.`);
    process.exit(1);
  }
  console.log(`Match worker parity OK: ${items.length} venues, worker decisions identical to in-process matcher.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
