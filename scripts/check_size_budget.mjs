/*
 * Size budget guard for the packed extension.
 *
 * Fails CI when dist/ grows beyond the budget, so accidental bundling of large
 * assets (icons, media, datasets) is caught at PR time instead of at Web Store
 * upload time. Per-file budgets catch regressions hidden inside an otherwise
 * acceptable total (e.g. a 450 KB 16x16 icon).
 *
 * Usage: node scripts/check_size_budget.mjs   (after npm run build)
 */
import fs from "node:fs/promises";
import path from "node:path";

const DIST_DIR = path.join(process.cwd(), "dist");

// Budgets in bytes. The package now ships the compact SJR index instead of the
// raw CSV corpus, so the whole extension fits well under 40 MB.
const TOTAL_BUDGET = 40 * 1024 * 1024;
const FILE_BUDGETS = [
  { pattern: /^icons[\\/]icon16\.png$/, budget: 16 * 1024 },
  { pattern: /^icons[\\/]icon48\.png$/, budget: 32 * 1024 },
  { pattern: /^icons[\\/]icon128\.png$/, budget: 96 * 1024 },
  { pattern: /^images[\\/]/, budget: 0 }, // demo media must not ship in the package
  { pattern: /^sjr[\\/]/, budget: 0 }, // raw SCImago CSVs must not ship in the package
];

async function walk(dir, base = dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, base, out);
    } else if (entry.isFile()) {
      const stat = await fs.stat(full);
      out.push({ rel: path.relative(base, full), size: stat.size });
    }
  }
  return out;
}

let files;
try {
  files = await walk(DIST_DIR);
} catch {
  console.error(`dist/ not found — run "npm run build" first.`);
  process.exit(1);
}

const total = files.reduce((sum, file) => sum + file.size, 0);
const failures = [];

if (total > TOTAL_BUDGET) {
  failures.push(`Total dist size ${(total / 1024 / 1024).toFixed(1)} MB exceeds budget ${(TOTAL_BUDGET / 1024 / 1024).toFixed(1)} MB`);
}

for (const file of files) {
  for (const { pattern, budget } of FILE_BUDGETS) {
    if (pattern.test(file.rel) && file.size > budget) {
      failures.push(`${file.rel}: ${(file.size / 1024).toFixed(1)} KB exceeds budget ${(budget / 1024).toFixed(1)} KB`);
    }
  }
}

console.log(`dist/: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB total (budget ${(TOTAL_BUDGET / 1024 / 1024).toFixed(0)} MB)`);
if (failures.length) {
  for (const failure of failures) console.error(`SIZE BUDGET FAIL: ${failure}`);
  process.exit(1);
}
console.log("Size budget OK.");
