/*
 * Emits a JSON inventory of every color literal in GSVR/inject.css with its
 * usage context (selector, property), for token-migration classification.
 *
 * Usage: node scripts/extract_color_inventory.mjs > color_inventory.json
 */
import fs from "node:fs";

const css = fs.readFileSync("GSVR/inject.css", "utf8");

// Crude but effective CSS walker: track the current selector, then scan each
// declaration for color literals.
const COLOR_RX = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const entries = [];
let selector = "";
let buffer = "";
let inBlock = false;

for (const rawLine of css.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!inBlock) {
    buffer += ` ${line}`;
    if (line.endsWith("{")) {
      selector = buffer.replace(/\{$/, "").trim().replace(/\s+/g, " ");
      buffer = "";
      inBlock = true;
    }
  } else {
    if (line.startsWith("}")) {
      inBlock = false;
      buffer = "";
      continue;
    }
    const declMatch = line.match(/^([a-zA-Z-]+)\s*:\s*(.+?);?$/);
    if (!declMatch) continue;
    const [, property, value] = declMatch;
    for (const color of value.match(COLOR_RX) || []) {
      entries.push({
        color: color.toLowerCase().replace(/\s+/g, ""),
        property,
        selector: selector.slice(0, 120),
      });
    }
  }
}

const byColor = new Map();
for (const entry of entries) {
  if (!byColor.has(entry.color)) byColor.set(entry.color, { color: entry.color, count: 0, usages: [] });
  const record = byColor.get(entry.color);
  record.count++;
  if (record.usages.length < 999) record.usages.push(`${entry.property} @ ${entry.selector}`);
}

const inventory = [...byColor.values()].sort((a, b) => b.count - a.count);
console.log(JSON.stringify({ total: entries.length, distinct: inventory.length, inventory }, null, 1));
