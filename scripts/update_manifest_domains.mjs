/*
 * Rewrites the scholar.google.* domain lists in GSVR/manifest.json from one
 * canonical list, keeping content_scripts.matches, host_permissions, and
 * web_accessible_resources[0].matches in sync.
 *
 * The list is the union of Google's published ccTLD set
 * (https://www.google.com/supported_domains, fetched 2026-06-11) and the
 * domains the manifest already shipped with. Match patterns for ccTLDs where
 * Scholar is not actually served are harmless — they simply never match.
 *
 * Usage: node scripts/update_manifest_domains.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const GOOGLE_CCTLDS = [
  "ad", "ae", "com.af", "com.ag", "al", "am", "co.ao", "com.ar", "as", "at",
  "com.au", "az", "ba", "com.bd", "be", "bf", "bg", "com.bh", "bi", "bj",
  "com.bn", "com.bo", "com.br", "bs", "bt", "co.bw", "by", "com.bz", "ca",
  "cd", "cf", "cg", "ch", "ci", "co.ck", "cl", "cm", "cn", "com.co", "co.cr",
  "com.cu", "cv", "com.cy", "cz", "de", "dj", "dk", "dm", "com.do", "dz",
  "com.ec", "ee", "com.eg", "es", "com.et", "fi", "com.fj", "fm", "fr", "ga",
  "ge", "gg", "com.gh", "com.gi", "gl", "gm", "gr", "com.gt", "gy", "com.hk",
  "hn", "hr", "ht", "hu", "co.id", "ie", "co.il", "im", "co.in", "iq", "is",
  "it", "je", "com.jm", "jo", "co.jp", "co.ke", "com.kh", "ki", "kg", "co.kr",
  "com.kw", "kz", "la", "com.lb", "li", "lk", "co.ls", "lt", "lu", "lv",
  "com.ly", "co.ma", "md", "me", "mg", "mk", "ml", "com.mm", "mn", "com.mt",
  "mu", "mv", "mw", "com.mx", "com.my", "co.mz", "com.na", "com.ng", "com.ni",
  "ne", "nl", "no", "com.np", "nr", "nu", "co.nz", "com.om", "com.pa",
  "com.pe", "com.pg", "com.ph", "com.pk", "pl", "pn", "com.pr", "ps", "pt",
  "com.py", "com.qa", "ro", "ru", "rw", "com.sa", "com.sb", "sc", "se",
  "com.sg", "sh", "si", "sk", "com.sl", "sn", "so", "sm", "sr", "st",
  "com.sv", "td", "tg", "co.th", "com.tj", "tl", "tm", "tn", "to", "com.tr",
  "tt", "com.tw", "co.tz", "com.ua", "co.ug", "co.uk", "com.uy", "co.uz",
  "com.vc", "co.ve", "co.vi", "com.vn", "vu", "ws", "rs", "co.za", "co.zm",
  "co.zw", "cat",
];

// Domains the manifest shipped with that are not in Google's current list
// (kept so no previously-supported host regresses).
const LEGACY_EXTRAS = ["us", "il", "kr", "ua"];

const EXTRA_HOST_PERMISSIONS = [
  "https://dblp.org/*",
  "https://scholar.googleusercontent.com/*",
  "https://sparql.dblp.org/*",
];

function buildScholarMatches() {
  const suffixes = new Set([...GOOGLE_CCTLDS, ...LEGACY_EXTRAS]);
  const patterns = ["https://scholar.google.com/*"];
  for (const suffix of [...suffixes].sort()) {
    patterns.push(`https://scholar.google.${suffix}/*`);
  }
  return patterns;
}

const root = process.cwd();
const manifestPath = path.join(root, "GSVR", "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

const scholarMatches = buildScholarMatches();

manifest.content_scripts[0].matches = scholarMatches;
manifest.host_permissions = [...scholarMatches, ...EXTRA_HOST_PERMISSIONS];
for (const resource of manifest.web_accessible_resources || []) {
  resource.matches = scholarMatches;
}

await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Updated ${manifestPath} with ${scholarMatches.length} scholar.google.* match patterns.`);
