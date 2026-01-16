const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FUZZY_THRESHOLD = 0.90;

const contentJsPath = path.join(__dirname, '..', 'content.js');
const contentJs = fs.readFileSync(contentJsPath, 'utf8');

function extractObjectLiteral(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*({[\\s\\S]*?^});`, 'm');
  const m = contentJs.match(re);
  if (!m) throw new Error(`Failed to extract ${name}`);
  return m[1];
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pull COMMON_ABBREVIATIONS directly from the repo's content.js to avoid drift.
const COMMON_ABBREVIATIONS = vm.runInNewContext('(' + extractObjectLiteral('COMMON_ABBREVIATIONS') + ')');

function cleanTextForComparison(text, isGoogleScholarVenue = false) {
  if (!text) return '';
  let cleanedText = String(text).toLowerCase();
  cleanedText = cleanedText.replace(/&/g, ' and ');
  cleanedText = cleanedText.replace(/[\.,\/#!$%\^;\*:{}=\_`~?"“”()\[\]]/g, ' ');
  cleanedText = cleanedText.replace(/\s-\s/g, ' ');
  if (isGoogleScholarVenue) {
    cleanedText = cleanedText.replace(/^(\d{4}\s+|\d{1,2}(st|nd|rd|th)\s+)/, '');
    cleanedText = cleanedText.replace(/,\s*\d{4}$/, '');
    cleanedText = cleanedText.replace(/\(\d{4}\)$/, '');
    cleanedText = cleanedText.replace(/\b(part|volume|vol|issue|no|number)\s*\d+\b/g, ' ');
    cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, '');
  }
  cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, '');
  cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

  // Expand abbreviations after punctuation normalization (mirrors repo behavior).
  for (const [abbr, expansion] of Object.entries(COMMON_ABBREVIATIONS)) {
    const regex = new RegExp(`\\b${escapeRegExp(abbr)}\\b`, 'gi');
    cleanedText = cleanedText.replace(regex, expansion);
  }

  cleanedText = cleanedText.replace(/\s+/g, ' ');
  return cleanedText.trim();
}

function normalizeJournalName(name) {
  if (!name) return '';
  let cleaned = cleanTextForComparison(name, true);
  if (!cleaned) return '';
  cleaned = cleaned.replace(/\b\d{1,6}\b/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  const STOP = new Set([
    'a','an','the','of','and','for','in','on','to','at',
    'journal','international','transactions','letters'
  ]);

  const stem = (tok) => {
    if (tok.length <= 4) return tok;
    if (tok.endsWith('ies') && tok.length > 5) return tok.slice(0, -3) + 'y';
    if (tok.endsWith('sses')) return tok;
    if (tok.endsWith('s') && !tok.endsWith('ss')) return tok.slice(0, -1);
    return tok;
  };

  const tokens = cleaned
    .split(' ')
    .map(t => t.trim())
    .filter(Boolean)
    .map(stem)
    .filter(t => t.length > 0 && !STOP.has(t));

  return tokens.join(' ').trim();
}

function generateJournalNormalizationVariants(name) {
  const base = normalizeJournalName(name);
  if (!base) return [];
  const variants = new Set([base]);
  if (/\bacm\s+computer\b/.test(base)) variants.add(base.replace(/\bacm\s+computer\b/g, 'acm computing'));
  if (/\bcomputer\s+survey\b/.test(base)) variants.add(base.replace(/\bcomputer\b/g, 'computing'));
  if (/\bcomputing\s+survey\b/.test(base)) variants.add(base.replace(/\bcomputing\b/g, 'computer'));
  return Array.from(variants);
}

function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  const a = String(s1);
  const b = String(s2);
  const bound = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const matchA = new Array(a.length).fill(false);
  const matchB = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - bound);
    const hi = Math.min(i + bound + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (!matchB[j] && a[i] === b[j]) {
        matchA[i] = true;
        matchB[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (matchA[i]) {
      while (!matchB[k]) k++;
      if (a[i] !== b[k]) transpositions++;
      k++;
    }
  }
  transpositions /= 2;

  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function parseSjrCsv(text) {
  const rows = [];
  let currentField = '';
  let currentRow = [];
  let inQuotes = false;
  const sanitized = text.replace(/\ufeff/g, '');

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

function createTokenSet(normalizedTitle) {
  const STOP_WORDS = new Set(['and', 'the', 'of', 'for', 'in', 'on', 'journal', 'international', 'transactions', 'letters']);
  const tokens = normalizedTitle
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

function loadDataset(year = 2024) {
  const csvPath = path.join(__dirname, '..', 'sjr', `scimagojr ${year}.csv`);
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseSjrCsv(text);
  const header = rows[0].map(c => c.trim().toLowerCase());
  const titleIndex = header.findIndex(c => c === 'title');
  const quartileIndex = header.findIndex(c => c === 'sjr best quartile');
  const typeIndex = header.findIndex(c => c === 'type');
  if (titleIndex < 0 || quartileIndex < 0) throw new Error('Header columns missing');

  const byNormalized = new Map();
  const entries = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length <= Math.max(titleIndex, quartileIndex)) continue;
    const type = typeIndex >= 0 ? (row[typeIndex] || '').trim().toLowerCase() : '';
    if (type && type !== 'journal') continue;
    const title = (row[titleIndex] || '').trim();
    if (!title) continue;
    const normalizedTitle = normalizeJournalName(title);
    if (!normalizedTitle) continue;
    const quartileRaw = (row[quartileIndex] || '').trim().toUpperCase();
    const quartile = /^Q[1-4]$/.test(quartileRaw) ? quartileRaw : null;

    let entry = byNormalized.get(normalizedTitle);
    if (!entry) {
      entry = {
        normalizedTitle,
        resolvedTitle: title,
        quartile,
        tokenSet: createTokenSet(normalizedTitle),
      };
      byNormalized.set(normalizedTitle, entry);
      entries.push(entry);
    }
  }

  return { byNormalized, entries };
}

function findBestSjrMatch(normalizedQuery, dataset) {
  const direct = dataset.byNormalized.get(normalizedQuery);
  if (direct) return { entry: direct, score: 1.0 };

  const queryTokens = normalizedQuery.split(' ').map(t => t.trim()).filter(t => t.length >= 3);
  const queryTokenSet = new Set(queryTokens);

  let best = null;
  for (const entry of dataset.entries) {
    let sharesToken = queryTokens.length === 0;
    if (!sharesToken) {
      for (const t of queryTokenSet) {
        if (entry.tokenSet.has(t)) { sharesToken = true; break; }
      }
    }
    if (!sharesToken) continue;

    const score = jaroWinkler(normalizedQuery, entry.normalizedTitle);
    if (score >= 0.98) return { entry, score };
    if (!best || score > best.score) best = { entry, score };
  }
  if (!best || best.score < FUZZY_THRESHOLD) return null;
  return best;
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
];

for (const name of examples) {
  const variants = generateJournalNormalizationVariants(name);
  let found = null;
  for (const v of variants) {
    const match = findBestSjrMatch(v, dataset);
    if (match) { found = { ...match, v }; break; }
  }
  if (!found) {
    console.log(`NO MATCH: ${name} -> variants=${variants.join(' | ')}`);
  } else {
    console.log(`MATCH: ${name} -> ${found.entry.resolvedTitle} quartile=${found.entry.quartile} score=${found.score.toFixed(3)} norm=${found.v}`);
  }
}
