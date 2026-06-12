/*
 * Applies the (color, role) -> token mapping to GSVR/inject.css:
 *  - every color literal in a declaration becomes var(--<token>)
 *  - the :root block gains the new token definitions (light values)
 *  - the existing :root tokens and any [data-gsr-theme] blocks are untouched
 *
 * Mapping file: scripts/data/color_token_map.json
 *   {
 *     "tokens": { "gsr-muted": "#5d7198", ... },           // token -> light value
 *     "mappings": { "#5b7299|text": "gsr-muted", ... },    // color|role -> token, or "KEEP"
 *     "selectorOverrides": [ { "pattern": "gsr-badge-popover", "token": "KEEP" } ]
 *   }
 * "KEEP" leaves the literal color in place — used for theme-stable colors
 * (data-visualization fills, the dark tooltip, branded export buttons) that
 * must NOT flip with the dark theme. selectorOverrides are consulted before
 * the (color, role) map for every declaration whose selector matches.
 *
 * Any (color, role) occurrence with no mapping is reported and left unchanged;
 * the script exits non-zero so migration gaps cannot slip through silently.
 *
 * Usage: node scripts/apply_token_migration.mjs [--check]
 */
import fs from "node:fs";

const CHECK_ONLY = process.argv.includes("--check");
const CSS_PATH = "GSVR/inject.css";
const MAP_PATH = "scripts/data/color_token_map.json";

const { tokens, mappings, selectorOverrides = [] } = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
const overrideRules = selectorOverrides.map((rule) => ({ rx: new RegExp(rule.pattern), token: rule.token }));
const css = fs.readFileSync(CSS_PATH, "utf8");

const COLOR_RX = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

function roleOf(property) {
  const p = property.toLowerCase();
  if (p === "color" || p === "-webkit-text-fill-color") return "text";
  if (p.startsWith("background")) return "background";
  if (p.startsWith("border") || p.startsWith("outline")) return "border";
  if (p.includes("shadow")) return "shadow";
  if (p === "fill" || p === "stroke") return "svg";
  return "other";
}

const lines = css.split(/\r?\n/);
const out = [];
const leftovers = new Map();
let replaced = 0;
let kept = 0;
let depth = 0;            // nesting depth (handles @media / @keyframes blocks)
let skipDepth = 0;        // inside :root or theme-override blocks
let pendingSelector = "";
let currentSelector = "";
let currentRole = "other"; // role of the most recent property (for value continuation lines)

function replaceColors(text) {
  const override = overrideRules.find((rule) => rule.rx.test(currentSelector));
  return text.replace(COLOR_RX, (literal) => {
    if (override) {
      if (override.token === "KEEP") {
        kept++;
        return literal;
      }
      replaced++;
      return `var(--${override.token})`;
    }
    const key = `${literal.toLowerCase().replace(/\s+/g, "")}|${currentRole}`;
    const token = mappings[key];
    if (!token) {
      leftovers.set(key, (leftovers.get(key) || 0) + 1);
      return literal;
    }
    if (token === "KEEP") {
      kept++;
      return literal;
    }
    replaced++;
    return `var(--${token})`;
  });
}

for (const rawLine of lines) {
  const trimmed = rawLine.trim();

  if (skipDepth > 0) {
    out.push(rawLine);
    if (trimmed.endsWith("{")) skipDepth++;
    if (trimmed.startsWith("}")) skipDepth--;
    continue;
  }

  if (trimmed.endsWith("{")) {
    const selector = `${pendingSelector} ${trimmed}`.replace(/\{$/, "").trim();
    pendingSelector = "";
    if (/:root\s*$/.test(selector) || /data-gsvr-theme|data-gsr-theme/.test(selector)) {
      skipDepth = 1;
      out.push(rawLine);
      continue;
    }
    // @media wrappers keep the inner selector meaningful for overrides.
    if (!/^@(media|supports)/.test(selector)) {
      currentSelector = selector;
    }
    depth++;
    currentRole = "other";
    out.push(rawLine);
    continue;
  }

  if (depth === 0) {
    pendingSelector += ` ${trimmed}`;
    out.push(rawLine);
    continue;
  }

  if (trimmed.startsWith("}")) {
    depth = Math.max(0, depth - 1);
    currentRole = "other";
    out.push(rawLine);
    continue;
  }

  const declMatch = rawLine.match(/^(\s*)([a-zA-Z-]+)(\s*:\s*)(.+?)(;?\s*)$/);
  if (declMatch) {
    const [, indent, property, sep, value, tail] = declMatch;
    currentRole = roleOf(property);
    out.push(`${indent}${property}${sep}${replaceColors(value)}${tail}`);
    continue;
  }

  // Value continuation line (multi-line gradients / box-shadow lists): uses
  // the role of the property opened on a previous line.
  if (/[#)]|rgba?\(/.test(trimmed) && !trimmed.startsWith("/*")) {
    out.push(replaceColors(rawLine));
    continue;
  }

  out.push(rawLine);
}

let result = out.join("\n");

// Append the new token definitions to the existing :root block.
const rootStart = result.indexOf(":root {");
const rootEnd = result.indexOf("}", rootStart);
if (rootStart === -1 || rootEnd === -1) {
  console.error("Could not locate the :root block in inject.css");
  process.exit(1);
}
const existingRoot = result.slice(rootStart, rootEnd);
const newDefs = Object.entries(tokens)
  .filter(([name]) => !existingRoot.includes(`--${name}:`))
  .map(([name, value]) => `  --${name}: ${value};`)
  .join("\n");
if (newDefs && !CHECK_ONLY) {
  result = `${result.slice(0, rootEnd)}${newDefs}\n${result.slice(rootEnd)}`;
}

console.log(`Replacements: ${replaced}`);
console.log(`Kept literal (theme-stable): ${kept}`);
console.log(`New token definitions: ${newDefs ? newDefs.split("\n").length : 0}`);
if (leftovers.size) {
  console.error(`UNMAPPED (color|role) pairs: ${leftovers.size}`);
  for (const [key, count] of [...leftovers.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${count}x ${key}`);
  }
  process.exit(1);
}

if (!CHECK_ONLY) {
  fs.writeFileSync(CSS_PATH, result);
  console.log(`Wrote ${CSS_PATH}`);
} else {
  console.log("Check passed (no file written).");
}
