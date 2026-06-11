import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Use the SAME normalization module as the runtime content script and the
// Node test mirror, so index keys and query keys can never drift apart.
const require = createRequire(import.meta.url);
const journalMatch = require("../GSVR/core/journal_match.js");

const { normalizeJournalName, createTokenSet, normalizeIssnList } = journalMatch;

function parseSjrCsv(text) {
  const rows = [];
  let currentField = "";
  let currentRow = [];
  let inQuotes = false;
  const sanitized = text.split(String.fromCharCode(0xfeff)).join("");

  for (let i = 0; i < sanitized.length; i++) {
    const char = sanitized[i];
    if (char === "\"") {
      if (inQuotes && sanitized[i + 1] === "\"") {
        currentField += "\"";
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ";" && !inQuotes) {
      currentRow.push(currentField);
      currentField = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && sanitized[i + 1] === "\n") i++;
      currentRow.push(currentField);
      currentField = "";
      if (currentRow.some((value) => value.trim().length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
    } else {
      currentField += char;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some((value) => value.trim().length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function chooseBetterQuartile(existing, nextValue) {
  if (!nextValue) return existing;
  if (!existing) return nextValue;
  const parse = (value) => {
    const match = String(value).match(/^Q(\d)$/i);
    return match ? parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
  };
  return parse(nextValue) < parse(existing) ? nextValue : existing;
}

export async function generateSjrIndex({ root = process.cwd() } = {}) {
  const srcDir = path.join(root, "GSVR");
  const sjrDir = path.join(srcDir, "sjr");
  const outDir = path.join(srcDir, "data");
  const outPath = path.join(outDir, "sjr-index.json");

  const files = (await fs.readdir(sjrDir))
    .filter((name) => /^scimagojr \d{4}\.csv$/i.test(name))
    .sort();

  // Identity model: one entry per SCImago sourceId. Distinct sourceIds are
  // never merged, even when their normalized titles collide — colliding keys
  // become multi-entry buckets that the runtime resolves via ISSN or abstains.
  const bySourceKey = new Map();
  let startYear = Number.POSITIVE_INFINITY;
  let endYear = Number.NEGATIVE_INFINITY;

  for (const fileName of files) {
    const yearMatch = fileName.match(/(\d{4})/);
    if (!yearMatch) continue;
    const year = Number(yearMatch[1]);
    if (!Number.isFinite(year)) continue;

    startYear = Math.min(startYear, year);
    endYear = Math.max(endYear, year);

    const csv = await fs.readFile(path.join(sjrDir, fileName), "utf8");
    const rows = parseSjrCsv(csv);
    if (!rows.length) continue;

    const header = rows[0].map((cell) => cell.trim().toLowerCase());
    const sourceIdIndex = header.findIndex((cell) => cell === "sourceid");
    const titleIndex = header.findIndex((cell) => cell === "title");
    const quartileIndex = header.findIndex((cell) => cell === "sjr best quartile");
    const typeIndex = header.findIndex((cell) => cell === "type");
    const issnIndex = header.findIndex((cell) => cell === "issn");
    const coverageIndex = header.findIndex((cell) => cell === "coverage");
    if (titleIndex === -1 || quartileIndex === -1) continue;

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (!row || row.length <= Math.max(titleIndex, quartileIndex)) continue;

      const type = typeIndex >= 0 ? row[typeIndex]?.trim().toLowerCase() : "";
      if (type && type !== "journal") continue;

      const title = row[titleIndex]?.trim();
      const quartileRaw = row[quartileIndex]?.trim().toUpperCase();
      const sourceId = sourceIdIndex >= 0 ? row[sourceIdIndex]?.trim() || null : null;
      const issns = issnIndex >= 0 ? normalizeIssnList(row[issnIndex]) : [];
      const coverage = coverageIndex >= 0 ? row[coverageIndex]?.trim() || null : null;
      if (!title || !/^Q[1-4]$/i.test(quartileRaw)) continue;

      const normalizedTitle = normalizeJournalName(title);
      if (!normalizedTitle) continue;

      const sourceKey = sourceId ? `sid:${sourceId}` : `title:${normalizedTitle}`;
      let entry = bySourceKey.get(sourceKey);
      if (!entry) {
        entry = {
          sourceId,
          resolvedTitle: title,
          latestTitle: title,
          latestTitleYear: year,
          aliasKeys: new Set(),
          quartilesByYear: {},
          issns: [],
          coverage,
          coverageYear: coverage ? year : null,
        };
        bySourceKey.set(sourceKey, entry);
      }

      entry.aliasKeys.add(normalizedTitle);
      if (title.length > entry.resolvedTitle.length) {
        entry.resolvedTitle = title;
      }
      if (year >= entry.latestTitleYear) {
        entry.latestTitle = title;
        entry.latestTitleYear = year;
      }
      if (coverage && (!entry.coverage || ((entry.coverageYear || 0) < 2010 && year >= 2010))) {
        entry.coverage = coverage;
        entry.coverageYear = year;
      }
      for (const issn of issns) {
        if (!entry.issns.includes(issn)) entry.issns.push(issn);
      }

      const existing = entry.quartilesByYear[year];
      entry.quartilesByYear[year] = chooseBetterQuartile(existing, quartileRaw);
    }
  }

  const entries = Array.from(bySourceKey.values()).map((entry) => {
    const primaryKey = normalizeJournalName(entry.latestTitle) || [...entry.aliasKeys][0];
    const aliases = [...entry.aliasKeys].filter((key) => key && key !== primaryKey).sort();
    return {
      n: primaryKey,
      a: aliases,
      t: entry.resolvedTitle,
      q: entry.quartilesByYear,
      k: [...createTokenSet(primaryKey)],
      i: entry.issns,
      s: entry.sourceId,
      c: entry.coverage,
    };
  }).sort((left, right) => left.n.localeCompare(right.n) || String(left.s || "").localeCompare(String(right.s || "")));

  // Collision diagnostics: how many exact keys are shared by >1 sourceId?
  const keyOwners = new Map();
  for (const entry of entries) {
    for (const key of new Set([entry.n, ...entry.a])) {
      if (!keyOwners.has(key)) keyOwners.set(key, new Set());
      keyOwners.get(key).add(entry.s || entry.t);
    }
  }
  const collidingKeys = [...keyOwners.values()].filter((owners) => owners.size > 1).length;

  const payload = {
    version: 3,
    startYear: Number.isFinite(startYear) ? startYear : null,
    endYear: Number.isFinite(endYear) ? endYear : null,
    entries,
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload));

  return {
    outPath,
    count: payload.entries.length,
    startYear: payload.startYear,
    endYear: payload.endYear,
    collidingKeys,
  };
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);

if (entryPath && entryPath === modulePath) {
  const result = await generateSjrIndex();
  console.log(`Generated SJR index: ${result.outPath}`);
  console.log(`Entries: ${result.count}`);
  console.log(`Years: ${result.startYear}–${result.endYear}`);
  console.log(`Exact keys shared by >1 journal (abstain buckets): ${result.collidingKeys}`);
}
