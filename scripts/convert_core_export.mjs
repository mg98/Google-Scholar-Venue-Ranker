/*
 * Converts CORE portal CSV exports into the bundled GSVR/core/CORE_<year>.json
 * format ({ title, acronym, rank } objects — the same lowercase keys both
 * loadCoreDataForFile and parseBundledCoreFile accept).
 *
 * Source exports (fetched from portal.core.edu.au/conf-ranks "Export"):
 *   core_export_CORE2013.csv -> GSVR/core/CORE_2013.json
 *   core_export_ERA2010.csv  -> GSVR/core/CORE_2010.json  (ERA 2010 list,
 *                               hosted by the CORE portal as the 2010 snapshot)
 *   core_export_CORE2008.csv -> GSVR/core/CORE_2008.json
 *
 * Export CSV columns: id, title, acronym, source, rank, hasDblpEntry, FoR, ...
 *
 * Usage: node scripts/convert_core_export.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const CONVERSIONS = [
  { input: "scripts/data/core_export_CORE2013.csv", output: "GSVR/core/CORE_2013.json", source: "CORE2013" },
  { input: "scripts/data/core_export_ERA2010.csv", output: "GSVR/core/CORE_2010.json", source: "ERA2010" },
  { input: "scripts/data/core_export_CORE2008.csv", output: "GSVR/core/CORE_2008.json", source: "CORE2008" },
];

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((value) => value.trim().length > 0)) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.trim().length > 0)) rows.push(row);
  }
  return rows;
}

const root = process.cwd();
for (const { input, output, source } of CONVERSIONS) {
  const csvPath = path.join(root, input);
  let text;
  try {
    text = await fs.readFile(csvPath, "utf8");
  } catch {
    console.error(`Skipping ${source}: ${input} not found. Download it from the CORE portal export first.`);
    continue;
  }

  const rows = parseCsv(text);
  const entries = [];
  for (const row of rows) {
    // id, title, acronym, source, rank, hasDblp, FoR, ...
    if (row.length < 5) continue;
    const title = String(row[1] || "").trim();
    const acronym = String(row[2] || "").trim();
    const rowSource = String(row[3] || "").trim();
    const rank = String(row[4] || "").trim();
    if (!title && !acronym) continue;
    if (rowSource && rowSource !== source) continue;
    entries.push({ title, acronym, rank });
  }

  const outPath = path.join(root, output);
  await fs.writeFile(outPath, JSON.stringify(entries, null, 1));
  const rankCounts = entries.reduce((counts, entry) => {
    counts[entry.rank] = (counts[entry.rank] || 0) + 1;
    return counts;
  }, {});
  console.log(`${source}: ${entries.length} entries -> ${output}`);
  console.log(`  ranks: ${Object.entries(rankCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([rank, count]) => `${rank || "(empty)"}=${count}`).join(", ")}`);
}
