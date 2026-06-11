/*
 * Standalone smoke test: run a handful of real DBLP-style journal names
 * against the 2024 SCImago CSV using the SHARED journal matcher
 * (core/journal_match.js) — the same code path the content script, the
 * benchmark mirror, and the index generator use.
 *
 * Usage: node GSVR/tests/sjr_smoke_test.js
 */
const fs = require('fs');
const path = require('path');

const jm = require('../core/journal_match.js');

function parseSjrCsv(text) {
  const rows = [];
  let currentField = '';
  let currentRow = [];
  let inQuotes = false;
  const sanitized = text.split(String.fromCharCode(0xfeff)).join('');

  for (let i = 0; i < sanitized.length; i++) {
    const char = sanitized[i];
    if (char === '"') {
      if (inQuotes && sanitized[i + 1] === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ';' && !inQuotes) {
      currentRow.push(currentField);
      currentField = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && sanitized[i + 1] === '\n') i++;
      currentRow.push(currentField);
      currentField = '';
      if (currentRow.some(v => v.trim().length > 0)) rows.push(currentRow);
      currentRow = [];
    } else {
      currentField += char;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some(v => v.trim().length > 0)) rows.push(currentRow);
  }

  return rows;
}

function loadDataset(year = 2024) {
  const csvPath = path.join(__dirname, '..', 'sjr', `scimagojr ${year}.csv`);
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseSjrCsv(text);
  const header = rows[0].map(c => c.trim().toLowerCase());
  const sourceIdIndex = header.findIndex(c => c === 'sourceid');
  const titleIndex = header.findIndex(c => c === 'title');
  const quartileIndex = header.findIndex(c => c === 'sjr best quartile');
  const typeIndex = header.findIndex(c => c === 'type');
  const issnIndex = header.findIndex(c => c === 'issn');
  if (titleIndex < 0 || quartileIndex < 0) throw new Error('Header columns missing');

  // Same identity model as the generated index: one entry per sourceId,
  // byNormalized maps key -> array of entries.
  const bySourceKey = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length <= Math.max(titleIndex, quartileIndex)) continue;
    const type = typeIndex >= 0 ? (row[typeIndex] || '').trim().toLowerCase() : '';
    if (type && type !== 'journal') continue;
    const title = (row[titleIndex] || '').trim();
    if (!title) continue;
    const normalizedTitle = jm.normalizeJournalName(title);
    if (!normalizedTitle) continue;
    const quartileRaw = (row[quartileIndex] || '').trim().toUpperCase();
    const quartile = /^Q[1-4]$/.test(quartileRaw) ? quartileRaw : null;
    const sourceId = sourceIdIndex >= 0 ? (row[sourceIdIndex] || '').trim() || null : null;
    const issns = issnIndex >= 0 ? jm.normalizeIssnList(row[issnIndex]) : [];
    const sourceKey = sourceId ? `sid:${sourceId}` : `title:${normalizedTitle}`;

    if (!bySourceKey.has(sourceKey)) {
      bySourceKey.set(sourceKey, {
        normalizedTitle,
        resolvedTitle: title,
        sourceId,
        quartile,
        quartilesByYear: quartile ? { [year]: quartile } : {},
        issns,
        tokenSet: jm.createTokenSet(normalizedTitle),
      });
    }
  }

  const entries = Array.from(bySourceKey.values());
  const byNormalized = new Map();
  const byIssn = new Map();
  for (const entry of entries) {
    const bucket = byNormalized.get(entry.normalizedTitle);
    if (!bucket) byNormalized.set(entry.normalizedTitle, [entry]);
    else bucket.push(entry);
    for (const issn of entry.issns) {
      if (!byIssn.has(issn)) byIssn.set(issn, []);
      byIssn.get(issn).push(entry);
    }
  }

  return { entries, byNormalized, byIssn, tokenIndex: jm.createSjrTokenIndex(entries) };
}

const dataset = loadDataset(2024);

const examples = [
  'Int. J. Distributed Sens. Networks',
  'Commun. ACM',
  'Comput. Commun. Rev.',
  'J. Syst. Archit.',
  'J. Netw. Comput. Appl.',
  'ACM Comput. Surv.',
  'Int. J. Wirel. Inf. Networks',
  'Inf. Process. Manag.',
  'Information Processing & Management',
];

let failures = 0;
for (const name of examples) {
  const variants = jm.generateJournalNormalizationVariants(name);
  let found = null;
  for (const v of variants) {
    const match = jm.findBestSjrMatch({ normalizedQuery: v, queryIssns: [], dataset, rawQuery: name });
    if (match && match.status === 'matched' && match.entry) {
      found = { ...match, v };
      break;
    }
  }
  if (!found) {
    failures++;
    console.log(`NO MATCH: ${name} -> variants=${variants.join(' | ')}`);
  } else {
    console.log(`MATCH: ${name} -> ${found.entry.resolvedTitle} quartile=${found.entry.quartile} score=${found.score.toFixed(3)} matchedBy=${found.matchedBy} norm=${found.v}`);
  }
}

// Identity-model regression: previously-merged journals must now stay distinct.
const collisionChecks = [
  ['Diabetes', 'Journal of Diabetes'],
  ['Genetics', 'Journal of Genetics'],
  ['Neuroscience', 'Journal of Neuroscience'],
];
for (const [a, b] of collisionChecks) {
  const matchA = jm.findBestSjrMatch({ normalizedQuery: jm.normalizeJournalName(a), queryIssns: [], dataset, rawQuery: a });
  const matchB = jm.findBestSjrMatch({ normalizedQuery: jm.normalizeJournalName(b), queryIssns: [], dataset, rawQuery: b });
  const okA = matchA.status === 'matched' && matchA.entry.resolvedTitle === a;
  const okB = matchB.status === 'matched' && matchB.entry.resolvedTitle === b;
  if (!okA || !okB) {
    failures++;
    console.log(`IDENTITY FAIL: "${a}" -> ${matchA.status}/${matchA.entry?.resolvedTitle}; "${b}" -> ${matchB.status}/${matchB.entry?.resolvedTitle}`);
  } else {
    console.log(`IDENTITY OK: "${a}" (${matchA.entry.quartile}) stays distinct from "${b}" (${matchB.entry.quartile})`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll SJR smoke checks passed.');
}
