/*
 * Builds the FINAL scripts/data/color_token_map.json from the rule-based
 * proposal plus human-reviewed decisions for every flagged bucket.
 *
 * Decisions encoded here (reviewed against the flagged contexts):
 *  - Theme-stable surfaces stay literal via selectorOverrides=KEEP:
 *    data-vis fills (rank bars, timeline segments, completeness segments,
 *    export ranked-bars), the dark tooltip (.gsr-badge-popover), branded
 *    export action buttons, footer action icons, the progress-bar gradient,
 *    and the amber "lifecycle failed" notice family.
 *  - Themed flags map onto semantic tokens (see MANUAL below).
 *
 * Usage: node scripts/finalize_color_map.mjs
 */
import fs from "node:fs";

const proposal = JSON.parse(fs.readFileSync("scripts/data/color_token_map.proposed.json", "utf8"));

const SELECTOR_OVERRIDES = [
  { pattern: "gsr-badge-popover", token: "KEEP" },
  { pattern: "gsr-export-panel__action-button|gsr-export-panel__badge", token: "KEEP" },
  { pattern: "gsr-summary-footer__action-icon", token: "KEEP" },
  { pattern: "gsr-progress-bar-inner", token: "KEEP" },
  { pattern: "gsr-summary-row__bar-fill|gsr-timeline-histogram__segment|gsr-timeline-histogram__legend-swatch|gsr-timeline-histogram__empty|gsr-completeness-bar__segment|gsr-export-panel__ranked-bar-segment|gsr-faculty-score-card__tier-swatch", token: "KEEP" },
  { pattern: "gsr-summary-lifecycle--failed", token: "KEEP" },
];

// (color|role) -> token for every flagged bucket NOT covered by a selector
// override. "KEEP" = stays literal.
const MANUAL = {
  "#17315d|border": "gsr-ink-strong",
  "#1f5fe0|shadow": "gsr-accent",
  "#153064|background": "gsr-ink-strong",
  "#495b8c|text": "gsr-neutral-ink",
  "#44567d|text": "gsr-neutral-ink",
  "#b23a3a|text": "gsr-danger-ink",
  "#c9d4e7|background": "KEEP", // histogram empty-state strip (data-vis area)
  "#7890a8|background": "KEEP", // completeness excludedType segment
  "#7da4e8|background": "KEEP", // export ranked-bar journal segment
  "#102a5f|background": "KEEP", // timeline A* segment (navy data encoding)
  "#7a9b21|background": "KEEP", // timeline B segment
  "#8ba728|background": "KEEP", // timeline Q3 segment
  "#a9770f|background": "KEEP", // timeline Q1 deep segment
  "#d8af21|background": "KEEP", // summary bar A*
  "#52b14b|background": "KEEP", // summary bar A
  "#8bb62f|background": "KEEP", // summary bar B
  "#ec7f42|background": "KEEP", // summary bar C
  "#95b92a|background": "KEEP", // summary bar Q3
  "#ec6f4e|background": "KEEP", // summary bar Q4
  "#5e83de|background": "KEEP", // summary bar publication-match-missing
  "#7b8fcf|background": "KEEP", // summary bar unranked
  "#4f6ea8|background": "KEEP", // about footer icon chip
  "#4a67a1|background": "KEEP", // progress gradient stop
  "#7a91c0|background": "KEEP", // progress gradient stop
  "#935014|text": "KEEP", // lifecycle failed title (amber family)
  "#89673f|text": "KEEP", // lifecycle failed message
  "#0f1b3d|background": "KEEP", // popover surface
  "#9fb7f5|text": "KEEP", // popover label
  "#4f88f1|background": "KEEP", // export button gradients
  "#176ca4|background": "KEEP",
  "#2f8cb9|background": "KEEP",
  "#4b86f6|background": "KEEP",
  "#5b93f5|background": "KEEP",
  "#135f93|background": "KEEP",
  "#3597c5|background": "KEEP",
  "rgba(19,95,147,0.82)|border": "KEEP",
  "rgba(255,221,112,0.18)|background": "KEEP", // gold score washes
  "rgba(255,216,79,0.14)|background": "KEEP",
};

const NEW_TOKENS = {
  "gsr-danger-ink": "#b23a3a",
};

// Multi-line gradient/box-shadow continuation values were invisible to the
// bucket inventory (single-line extractor); this closed list was reviewed by
// hand. Role labels mirror what the migration walker reports for these lines.
// Glass-white gradient stops THEME (a white dialog gradient in dark mode is
// broken); navy shadow tints, faint decorative glows, gold washes, and
// data-vis insets stay literal.
const CONTINUATION = {
  "#ffffff|border": "gsr-card",
  "#f8fafc|border": "gsr-card-tint",
  "rgba(247,250,255,0.98)|border": "gsr-veil-strong",
  "rgba(242,246,255,0.99)|other": "gsr-veil-strong",
  "rgba(252,253,255,0.98)|other": "gsr-veil-strong",
  "rgba(252,253,255,0.98)|border": "gsr-veil-strong",
  "rgba(255,255,255,0.98)|other": "gsr-veil-strong",
  "rgba(248,250,252,0.96)|other": "gsr-veil-strong",
  "rgba(255,255,255,0.99)|border": "gsr-veil-strong",
  "rgba(245,248,255,0.99)|border": "gsr-veil-strong",
  "rgba(244,247,255,0.95)|border": "gsr-veil-strong",
  "rgba(255,255,255,0.96)|border": "gsr-veil-strong",
  "rgba(244,248,255,0.94)|border": "gsr-veil-strong",
  "rgba(255,255,255,0.92)|background": "gsr-veil",
  "rgba(255,255,255,0.88)|background": "gsr-veil",
  "rgba(255,255,255,0.86)|border": "gsr-veil",
  "rgba(255,255,255,0.88)|border": "gsr-veil",
  "rgba(255,255,255,0.9)|border": "gsr-veil",
  "rgba(255,255,255,0.78)|border": "gsr-veil",
  "rgba(255,255,255,0.25)|text": "KEEP",
  "rgba(31,75,142,0.1)|background": "KEEP",
  "rgba(34,76,151,0.26)|text": "KEEP",
  "rgba(37,72,130,0.08)|background": "KEEP",
  "rgba(190,205,232,0.84)|background": "KEEP",
  "rgba(23,49,95,0.04)|background": "KEEP",
  "rgba(216,183,100,0.42)|background": "KEEP",
  "rgba(146,101,13,0.05)|background": "KEEP",
  "rgba(74,103,161,0.08)|border": "KEEP",
  "rgba(31,95,224,0.12)|border": "gsr-glow",
  "rgba(31,95,224,0.1)|border": "gsr-glow",
  "rgba(31,95,224,0.06)|border": "KEEP",
  "rgba(15,23,42,0.26)|border": "KEEP",
  "rgba(41,72,136,0.14)|border": "KEEP",
  "rgba(255,219,100,0.13)|border": "KEEP",
};

const mappings = { ...proposal.mappings };
const unresolved = [];
for (const flag of proposal.flagged) {
  const key = `${flag.color}|${flag.role}`;
  if (MANUAL[key]) {
    mappings[key] = MANUAL[key];
    continue;
  }
  const coveredBySelector = flag.contexts.every((ctx) =>
    SELECTOR_OVERRIDES.some((rule) => new RegExp(rule.pattern).test(ctx))
  );
  if (coveredBySelector) {
    mappings[key] = "KEEP";
    continue;
  }
  // :root token-definition lines are skipped by the migration walker entirely.
  if (flag.contexts.every((ctx) => /@\s*\/\*.*:root|--gsr-/.test(ctx))) {
    continue;
  }
  unresolved.push(flag);
}

if (unresolved.length) {
  console.error(`UNRESOLVED flagged buckets: ${unresolved.length}`);
  for (const flag of unresolved) {
    console.error(` ${flag.color}|${flag.role} — ${flag.reason}\n   ${flag.contexts[0]}`);
  }
  process.exit(1);
}

Object.assign(mappings, CONTINUATION);

const final = {
  tokens: { ...proposal.tokens, ...NEW_TOKENS },
  mappings,
  selectorOverrides: SELECTOR_OVERRIDES,
};
fs.writeFileSync("scripts/data/color_token_map.json", JSON.stringify(final, null, 1));
console.log(`Final map: ${Object.keys(mappings).length} mappings, ${Object.keys(final.tokens).length} tokens, ${SELECTOR_OVERRIDES.length} selector overrides`);
