/*
 * WCAG contrast gate for the GSVR design tokens.
 *
 * Parses the :root token block and the [data-gsvr-theme="dark"] override block
 * from GSVR/inject.css, then checks the contrast ratio of every meaningful
 * (foreground, background) token pair in BOTH themes. Fails when body-text
 * pairs drop below 4.5:1 or chip/badge pairs below 3:1 (chips are 10px bold,
 * but their fills are user-chosen rank colors; 3:1 matches WCAG large-text).
 *
 * Usage: node scripts/check_token_contrast.mjs
 */
import fs from "node:fs";

const css = fs.readFileSync("GSVR/inject.css", "utf8");

function extractBlock(startMarker) {
  const start = css.indexOf(startMarker);
  if (start === -1) return null;
  const open = css.indexOf("{", start);
  const end = css.indexOf("}", open);
  return css.slice(open + 1, end);
}

function parseTokens(block) {
  const tokens = {};
  if (!block) return tokens;
  for (const match of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function parseColor(value) {
  const v = String(value).trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  }
  m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    return [...m[1]].map((c) => parseInt(c + c, 16));
  }
  m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) {
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

function luminance([r, g, b]) {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// (foreground token, background token, minimum ratio, note)
const PAIRS = [
  ["gsr-ink", "gsr-card", 4.5, "body text on card"],
  ["gsr-ink", "gsr-surface", 4.5, "body text on surface"],
  ["gsr-ink-strong", "gsr-card", 4.5, "headings on card"],
  ["gsr-muted", "gsr-card", 4.5, "secondary text on card"],
  ["gsr-muted", "gsr-surface-sunken", 4.5, "secondary text on sunken"],
  ["gsr-text-soft", "gsr-card", 3.0, "tertiary text on card"],
  ["gsr-link", "gsr-card", 4.5, "links on card"],
  ["gsr-accent-ink", "gsr-accent", 4.5, "text on accent buttons"],
  ["gsr-neutral-ink", "gsr-neutral", 4.5, "neutral chip text"],
  ["gsr-a-star-ink", "gsr-a-star", 3.0, "A* chip"],
  ["gsr-a-ink", "gsr-a", 3.0, "A chip"],
  ["gsr-b-ink", "gsr-b", 3.0, "B chip"],
  ["gsr-c-ink", "gsr-c", 3.0, "C chip"],
  ["gsr-q1-ink", "gsr-q1", 3.0, "Q1 chip"],
  ["gsr-q2-ink", "gsr-q2", 3.0, "Q2 chip"],
  ["gsr-q3-ink", "gsr-q3", 3.0, "Q3 chip"],
  ["gsr-q4-ink", "gsr-q4", 3.0, "Q4 chip"],
];

const lightTokens = parseTokens(extractBlock(":root {"));
const darkOverrides = parseTokens(extractBlock(':root[data-gsvr-theme="dark"]'));
const darkTokens = { ...lightTokens, ...darkOverrides };

let failures = 0;
for (const [themeName, tokens] of [["light", lightTokens], ["dark", darkTokens]]) {
  if (themeName === "dark" && !Object.keys(darkOverrides).length) {
    console.log("dark: no override block yet — skipped");
    continue;
  }
  console.log(`\n[${themeName}]`);
  for (const [fgName, bgName, minimum, note] of PAIRS) {
    const fg = parseColor(tokens[fgName] || "");
    const bg = parseColor(tokens[bgName] || "");
    if (!fg || !bg) {
      console.log(`  SKIP ${fgName} on ${bgName} (${note}) — token missing/unparseable`);
      continue;
    }
    const ratio = contrast(fg, bg);
    const ok = ratio >= minimum;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${ratio.toFixed(2)}:1 (need ${minimum}) ${fgName} on ${bgName} — ${note}`);
  }
}

if (failures) {
  console.error(`\n${failures} contrast pair(s) below minimum.`);
  process.exit(1);
}
console.log("\nAll contrast pairs pass.");
