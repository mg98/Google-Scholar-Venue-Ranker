/*
 * Rule-based classifier: maps every (color, role) bucket from
 * color_buckets.json onto the GSVR semantic token taxonomy.
 *
 * Output: scripts/data/color_token_map.proposed.json
 *   { tokens, mappings, flagged } — flagged entries need human review.
 *
 * Usage: node scripts/classify_colors.mjs
 */
import fs from "node:fs";

const buckets = JSON.parse(fs.readFileSync("color_buckets.json", "utf8"));

// Token anchors: light values. Order matters only for ties.
const TOKENS = {
  // surfaces
  "gsr-surface": "#f3f7ff",
  "gsr-card": "#ffffff",
  "gsr-card-tint": "#fbfdff",
  "gsr-surface-sunken": "#edf3ff",
  "gsr-accent-soft": "#e7efff",
  // text
  "gsr-ink": "#13264a",
  "gsr-ink-strong": "#17315f",
  "gsr-muted": "#5d7198",
  "gsr-text-soft": "#7890a8",
  "gsr-accent-ink": "#ffffff",
  // accent
  "gsr-accent": "#1f5fe0",
  "gsr-accent-strong": "#184fc3",
  "gsr-link": "#214ca6",
  // borders
  "gsr-border": "#c8d6f0",
  "gsr-border-strong": "#809ddb",
  "gsr-border-soft": "#dce7f6",
  "gsr-neutral": "#e3ebff",
  "gsr-neutral-border": "#afc0ec",
  "gsr-neutral-ink": "#2f446b",
  // status
  "gsr-success": "#247a57",
  "gsr-warning": "#c5961c",
  "gsr-orange": "#d06a32",
  "gsr-danger": "#db536a",
  "gsr-purple": "#a65bd4",
  // ranks (fills)
  "gsr-a-star": "#ffd84f",
  "gsr-a": "#8cdf63",
  "gsr-b": "#b6dd48",
  "gsr-c": "#ff9a68",
  "gsr-q1": "#f4c942",
  "gsr-q2": "#7ccc5c",
  "gsr-q3": "#a7cd44",
  "gsr-q4": "#ff8b63",
  // rank companions (light values from the live stylesheet)
  "gsr-a-star-border": "#d6b335",
  "gsr-a-star-ink": "#664c00",
  "gsr-a-border": "#60b54c",
  "gsr-a-ink": "#1a5016",
  "gsr-b-border": "#91b42a",
  "gsr-b-ink": "#465c0d",
  "gsr-c-border": "#e17b44",
  "gsr-c-ink": "#7b2f09",
  "gsr-q1-border": "#d3aa29",
  "gsr-q1-ink": "#664c00",
  "gsr-q2-border": "#5ab243",
  "gsr-q2-ink": "#1f4f16",
  "gsr-q3-border": "#8cae28",
  "gsr-q3-ink": "#4d5e13",
  "gsr-q4-border": "#e0693f",
  "gsr-q4-ink": "#7b2a0e",
};

// Alpha tokens are matched by rule, not distance.
const ALPHA_TOKENS = {
  "gsr-glow": "rgba(31, 95, 224, 0.12)",
  "gsr-glow-strong": "rgba(31, 95, 224, 0.2)",
  "gsr-veil": "rgba(255, 255, 255, 0.9)",
  "gsr-veil-strong": "rgba(255, 255, 255, 0.97)",
  "gsr-veil-faint": "rgba(255, 255, 255, 0.5)",
  "gsr-shadow-tint": "rgba(24, 50, 102, 0.16)",
  "gsr-scrim": "rgba(15, 28, 55, 0.45)",
  "gsr-success-soft": "rgba(34, 197, 94, 0.1)",
};

const ROLE_TOKENS = {
  text: ["gsr-ink", "gsr-ink-strong", "gsr-muted", "gsr-text-soft", "gsr-accent-ink", "gsr-accent", "gsr-accent-strong", "gsr-link", "gsr-neutral-ink",
    "gsr-success", "gsr-warning", "gsr-orange", "gsr-danger", "gsr-purple",
    "gsr-a-star-ink", "gsr-a-ink", "gsr-b-ink", "gsr-c-ink", "gsr-q1-ink", "gsr-q2-ink", "gsr-q3-ink", "gsr-q4-ink"],
  background: ["gsr-surface", "gsr-card", "gsr-card-tint", "gsr-surface-sunken", "gsr-accent-soft", "gsr-neutral",
    "gsr-accent", "gsr-accent-strong",
    "gsr-success", "gsr-warning", "gsr-orange", "gsr-danger", "gsr-purple",
    "gsr-a-star", "gsr-a", "gsr-b", "gsr-c", "gsr-q1", "gsr-q2", "gsr-q3", "gsr-q4"],
  border: ["gsr-border", "gsr-border-strong", "gsr-border-soft", "gsr-neutral-border", "gsr-accent", "gsr-accent-strong",
    "gsr-success", "gsr-warning", "gsr-orange", "gsr-danger", "gsr-purple",
    "gsr-a-star-border", "gsr-a-border", "gsr-b-border", "gsr-c-border", "gsr-q1-border", "gsr-q2-border", "gsr-q3-border", "gsr-q4-border"],
  shadow: [],
  svg: ["gsr-ink", "gsr-muted", "gsr-accent"],
  other: ["gsr-accent", "gsr-border", "gsr-ink"],
};

const RANK_HINT_RX = /(astar|a-star|--a\b|badge--a\b|badge--b\b|badge--c\b|--q[1-4]|q1|q2|q3|q4|rank-badge|tier|legend|timeline-segment|swatch)/i;

function hexToRgb(value) {
  const v = value.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{6})$/);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  return null;
}

function parseRgba(value) {
  const m = value.match(/^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/);
  if (!m) return null;
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) };
}

function dist(a, b) {
  // Weighted RGB distance (rough perceptual weighting).
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db);
}

function classifyAlpha(color, role, contexts) {
  const parsed = parseRgba(color);
  if (!parsed || parsed.a >= 1) return null;
  const { rgb, a } = parsed;
  const [r, g, b] = rgb;
  const isWhite = r > 235 && g > 235 && b > 245;
  const isAccentBlue = b > 150 && b - r > 50 && g < 140;
  const isNavy = r < 80 && g < 90 && b < 140;
  const isGreen = g > 140 && g - r > 40 && g - b > 40;
  const contextText = contexts.join(" ");
  if (isGreen) return "gsr-success-soft";
  if (isWhite) {
    if (a >= 0.93) return "gsr-veil-strong";
    if (a >= 0.76) return "gsr-veil";
    return "gsr-veil-faint";
  }
  if (isAccentBlue) return a >= 0.14 ? "gsr-glow-strong" : "gsr-glow";
  if (isNavy) {
    if (role === "shadow") return "gsr-shadow-tint";
    if (/overlay|backdrop|scrim/i.test(contextText) && a >= 0.3) return "gsr-scrim";
    return a >= 0.3 ? "gsr-scrim" : "gsr-shadow-tint";
  }
  if (role === "shadow") return "gsr-shadow-tint";
  return null;
}

const mappings = {};
const flagged = [];
for (const bucket of buckets) {
  const { color, role, contexts, count } = bucket;
  const key = `${color}|${role}`;

  // Alpha colors first.
  const alphaToken = classifyAlpha(color, role, contexts);
  if (alphaToken) {
    mappings[key] = alphaToken;
    continue;
  }

  const rgb = hexToRgb(color) || parseRgba(color)?.rgb;
  if (!rgb) {
    flagged.push({ ...bucket, reason: "unparseable" });
    continue;
  }

  const rankHinted = contexts.some((ctx) => RANK_HINT_RX.test(ctx));
  let candidates = ROLE_TOKENS[role] || [];
  if (role === "shadow") {
    // Opaque shadow colors are rare; flag them.
    flagged.push({ ...bucket, reason: "opaque shadow color" });
    continue;
  }
  if (!rankHinted) {
    candidates = candidates.filter((token) => !/^gsr-(a|b|c|q[1-4])(-star)?(-border|-ink)?$/.test(token) || /^gsr-(accent|border)/.test(token));
  }

  let best = null;
  let second = null;
  for (const token of candidates) {
    const anchor = hexToRgb(TOKENS[token]);
    if (!anchor) continue;
    const d = dist(rgb, anchor);
    if (!best || d < best.d) {
      second = best;
      best = { token, d };
    } else if (!second || d < second.d) {
      second = { token, d };
    }
  }

  if (!best) {
    flagged.push({ ...bucket, reason: "no candidates" });
    continue;
  }
  // Distance thresholds: tight = confident, loose = flag for review.
  if (best.d <= 18) {
    mappings[key] = best.token;
  } else if (best.d <= 38 && (!second || second.d - best.d > 8)) {
    mappings[key] = best.token;
  } else {
    flagged.push({ ...bucket, reason: `nearest ${best.token} d=${best.d.toFixed(1)}${second ? `, second ${second.token} d=${second.d.toFixed(1)}` : ""}` });
  }
}

const proposal = { tokens: { ...TOKENS, ...ALPHA_TOKENS }, mappings, flagged };
fs.mkdirSync("scripts/data", { recursive: true });
fs.writeFileSync("scripts/data/color_token_map.proposed.json", JSON.stringify(proposal, null, 1));
console.log(`mapped: ${Object.keys(mappings).length} / ${buckets.length}; flagged: ${flagged.length}`);
for (const f of flagged.slice(0, 60)) {
  console.log(`FLAG ${f.color}|${f.role} x${f.count} — ${f.reason}\n     ${f.contexts[0] || ""}`);
}
