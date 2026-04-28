import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createHelpers(commonAbbreviations) {
  function cleanTextForComparison(text, isGoogleScholarVenue = false) {
    if (!text) return "";
    let cleanedText = String(text).toLowerCase();
    cleanedText = cleanedText.replace(/&/g, " and ");
    cleanedText = cleanedText.replace(/[\.,\/#!$%\^;\*:{}=\_`~?"“”()\[\]]/g, " ");
    cleanedText = cleanedText.replace(/\s-\s/g, " ");
    if (isGoogleScholarVenue) {
      cleanedText = cleanedText.replace(/^(\d{4}\s+|\d{1,2}(st|nd|rd|th)\s+)/, "");
      cleanedText = cleanedText.replace(/,\s*\d{4}$/, "");
      cleanedText = cleanedText.replace(/\(\d{4}\)$/, "");
      cleanedText = cleanedText.replace(/\b(part|volume|vol|issue|no|number)\s*\d+\b/g, " ");
    }
    cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, " ");
    cleanedText = cleanedText.replace(/\s+/g, " ").trim();

    for (const [abbr, expansion] of Object.entries(commonAbbreviations)) {
      const regex = new RegExp(`\\b${escapeRegExp(abbr)}\\b`, "gi");
      cleanedText = cleanedText.replace(regex, expansion);
    }

    return cleanedText.replace(/\s+/g, " ").trim();
  }

  function normalizeJournalName(name) {
    if (!name) return "";
    let cleaned = cleanTextForComparison(name, true);
    if (!cleaned) return "";
    cleaned = cleaned.replace(/\b\d{1,6}\b/g, " ");
    cleaned = cleaned.replace(/\s+/g, " ").trim();
    if (!cleaned) return "";

    const stop = new Set([
      "a", "an", "the", "of", "and", "for", "in", "on", "to", "at",
      "journal", "international", "transactions", "letters"
    ]);

    const stem = (token) => {
      if (token.length <= 4) return token;
      if (token.endsWith("ies") && token.length > 5) return token.slice(0, -3) + "y";
      if (token.endsWith("sses")) return token;
      if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
      return token;
    };

    return cleaned
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
      .map(stem)
      .filter((token) => token.length > 0 && !stop.has(token))
      .join(" ")
      .trim();
  }

  function createTokenSet(normalizedTitle) {
    const stopWords = new Set(["and", "the", "of", "for", "in", "on", "journal", "international", "transactions", "letters"]);
    return Array.from(new Set(
      normalizedTitle
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stopWords.has(token))
    ));
  }

  return {
    normalizeJournalName,
    createTokenSet
  };
}

async function readCommonAbbreviations(contentJsPath) {
  const source = await fs.readFile(contentJsPath, "utf8");
  const match = source.match(/const\s+COMMON_ABBREVIATIONS\s*=\s*({[\s\S]*?^});/m);
  if (!match) {
    throw new Error("Failed to extract COMMON_ABBREVIATIONS from content.js");
  }
  return vm.runInNewContext(`(${match[1]})`);
}

function parseSjrCsv(text) {
  const rows = [];
  let currentField = "";
  let currentRow = [];
  let inQuotes = false;
  const sanitized = text.replace(/\ufeff/g, "");

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

function normalizeIssnList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[;,]/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const normalized = String(item || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export async function generateSjrIndex({ root = process.cwd() } = {}) {
  const srcDir = path.join(root, "GSVR");
  const sjrDir = path.join(srcDir, "sjr");
  const outDir = path.join(srcDir, "data");
  const outPath = path.join(outDir, "sjr-index.json");
  const commonAbbreviations = await readCommonAbbreviations(path.join(srcDir, "content.js"));
  const { normalizeJournalName, createTokenSet } = createHelpers(commonAbbreviations);

  const files = (await fs.readdir(sjrDir))
    .filter((name) => /^scimagojr \d{4}\.csv$/i.test(name))
    .sort();

  const byNormalized = new Map();
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

      let entry = byNormalized.get(normalizedTitle);
      if (!entry) {
        entry = {
          normalizedTitle,
          resolvedTitle: title,
          quartilesByYear: {},
          tokens: createTokenSet(normalizedTitle),
          sourceId,
          issns,
          coverage
        };
        byNormalized.set(normalizedTitle, entry);
      } else if (title.length > entry.resolvedTitle.length) {
        entry.resolvedTitle = title;
      }

      if (!entry.sourceId && sourceId) entry.sourceId = sourceId;
      if (!entry.coverage && coverage) entry.coverage = coverage;
      for (const issn of issns) {
        if (!entry.issns.includes(issn)) entry.issns.push(issn);
      }

      const existing = entry.quartilesByYear[year];
      if (!existing || quartileRaw < existing) {
        entry.quartilesByYear[year] = quartileRaw;
      }
    }
  }

  const payload = {
    version: 2,
    startYear: Number.isFinite(startYear) ? startYear : null,
    endYear: Number.isFinite(endYear) ? endYear : null,
    entries: Array.from(byNormalized.values())
      .sort((a, b) => a.normalizedTitle.localeCompare(b.normalizedTitle))
      .map((entry) => ({
        n: entry.normalizedTitle,
        t: entry.resolvedTitle,
        q: entry.quartilesByYear,
        k: entry.tokens,
        i: entry.issns,
        s: entry.sourceId,
        c: entry.coverage
      }))
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload));

  return {
    outPath,
    count: payload.entries.length,
    startYear: payload.startYear,
    endYear: payload.endYear
  };
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);

if (entryPath && entryPath === modulePath) {
  const result = await generateSjrIndex();
  console.log(`Generated SJR index: ${result.outPath}`);
  console.log(`Entries: ${result.count}`);
  console.log(`Years: ${result.startYear}–${result.endYear}`);
}
