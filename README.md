![Version 1.9](https://img.shields.io/badge/version-1.9-blue.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# Google Scholar Venue Ranker (GSVR)

Google Scholar Venue Ranker is an open-source Chrome extension developed by [Naveed Bhatti](https://naveedanwarbhatti.github.io/). It augments Google Scholar profile pages with historical CORE conference ranks and SJR journal quartiles, using a strict DBLP-backed ranking pipeline instead of trusting editable Google Scholar venue text.

![Screenshot of Extension in Action](GSVR/images/Screenshot.png)

<p align="left">
  <a href="https://chromewebstore.google.com/detail/egohghgpljdhkmcmllhncfndmkeilpfb?utm_source=item-share-cb">
    <img src="https://developer.chrome.com/static/docs/webstore/branding/image/UV4C4ybeBTsZt43U4xis.png" alt="Available in the Chrome Web Store">
  </a>
</p>

## Why GSVR exists

Google Scholar is excellent at collecting publications, but it does not make venue quality easy to inspect, compare, or audit. In Computer Science, Electrical Engineering, and closely related areas, venue information matters a lot, and it is often the first thing people want to sanity-check when browsing a profile.

GSVR brings that context directly into Scholar with:

- inline conference and journal badges beside papers
- a compact summary panel with interactive filtering
- local ranking search without leaving Scholar
- explicit review states for papers that are unranked, ambiguous, or missing from DBLP

## What the extension does

- Adds historical CORE conference ranks (`A*`, `A`, `B`, `C`) to conference papers.
- Adds SJR quartiles (`Q1`, `Q2`, `Q3`, `Q4`) to journal papers.
- Uses DBLP metadata as the authoritative source for venue extraction and disambiguation.
- Chooses the most appropriate CORE snapshot by publication year.
- Uses a compact prebuilt SJR index for faster journal lookup on Scholar pages.
- Shows an interactive summary card for `Conference`, `Journal`, and `Review` states.
- Lets you filter/highlight papers by category directly from the summary panel.
- Includes a local `Search Ranking (CORE / SJR)` dialog for ad hoc venue checks.
- Includes a popup and full settings page for behavior and UI defaults.
- Includes an in-product About panel and report-bug workflow.

## Ranking policy and rules

GSVR is intentionally conservative. It prefers abstaining over showing a confident-looking wrong rank.

- DBLP is the trusted source for venue extraction.
  - Google Scholar profiles are user-editable.
  - DBLP entries cannot be freely added the same way, so venue metadata is more trustworthy for ranking decisions.
- CORE is used for conference ranking.
  - The extension bundles historical CORE datasets for `2014`, `2017`, `2018`, `2020`, `2021`, `2023`, and `2026`.
  - The publication year determines which ranking snapshot to consult.
- SJR is used for journal ranking.
  - The extension bundles official local SCImago CSVs for `2010` through `2024`.
  - A compact runtime index is generated at `GSVR/data/sjr-index.json` for faster lookup.
- Short conference papers under 6 pages are excluded.
  - This follows the same broad heuristic direction used by [CSRankings](https://csrankings.org/).
- Workshops, demos, posters, and extended abstracts are excluded from rank counting.
- Ambiguous matches abstain.
  - If the extension cannot resolve a venue confidently, it prefers `N/A`, `Unranked`, or `DBLP Missing` over a risky guess.
- Proceedings-style journal cases are handled explicitly.
  - Some venues such as `PVLDB`, `PACMPL`, `POMACS`, `TOG`, `CGF`, and `TVCG` need venue-specific handling rather than naive string matching.

## Product surfaces

### Scholar profile overlay

On supported Google Scholar profile pages, GSVR injects:

- inline rank chips next to publication titles
- a compact summary panel with quick filters
- row highlighting for selected categories
- links for `DBLP Profile`, `Search`, `Report`, and `About`

### Popup

The extension popup exposes quick controls for:

- `Run Automatically`
- `Compact Mode`
- `Show Unranked`
- `Default Highlight Mode`

### Full settings page

The options page adds:

- `Show Debug Details`
- persistent highlight defaults
- reset and save controls

### Search dialog

The built-in search dialog lets you query local CORE and SJR datasets without leaving Google Scholar. This is useful for quickly checking venue acronyms, aliases, merged venues, or journal quartiles.

### About panel

The About panel explains the extension's open-source status, authorship, ranking philosophy, and the main rules behind DBLP, CORE, SJR, and paper exclusion logic.

## Installation

### Option A: Chrome Web Store

Install from the Chrome Web Store using the badge above.

### Option B: Manual install from source or ZIP

1. Download a release ZIP from GitHub Releases, or use `Code -> Download ZIP` on GitHub and extract it.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the folder that contains `manifest.json`.
   - If you built locally, load `dist/`.
   - If you are loading the raw extension source, load `GSVR/`.
6. Open a Google Scholar profile page such as `https://scholar.google.com/citations?user=...`.

## Local development

### Prerequisites

- Node.js 18 or newer

### Build the extension

From the repository root:

```bash
npm install
npm run build
```

This produces a clean unpacked extension in `dist/`.

### Regenerate the compact SJR index

```bash
npm run generate:sjr-index
```

Use this when official SJR CSVs are updated locally and you want to rebuild `GSVR/data/sjr-index.json`.

### Create a distributable ZIP

```bash
npm run zip
```

## Testing

### Fast regression and unit tests

```bash
npm test
```

These tests cover key ranking behavior such as:

- deterministic DBLP title matching
- workshop vs parent-conference disambiguation
- demo/poster detection
- short-paper exclusion from page ranges
- venue normalization and alias cleanup

### Accuracy benchmark suite

GSVR also includes a separate ground-truth benchmark pipeline for ranking accuracy and latency evaluation.

Generate or refresh fixtures:

```bash
npm run benchmark:accuracy:fixtures
```

Run the gold benchmark suite:

```bash
npm run benchmark:accuracy -- --suite gold
```

Run all suites and refresh the stored baseline:

```bash
npm run benchmark:accuracy -- --suite all --write-baseline
```

Fail on benchmark regressions relative to the committed baseline:

```bash
npm run benchmark:accuracy -- --suite all --fail-on-regression
```

The benchmark system emits:

- per-family accuracy, precision, recall, abstain rate, ambiguity rate, and latency
- confusion matrices for status, conference rank, and journal quartile decisions
- JSON, Markdown, and HTML reports under `GSVR/tests/fixtures/accuracy/reports/`
- regression checks against `GSVR/tests/fixtures/accuracy/baseline.json`

## Repository layout

- `GSVR/` - extension source
- `GSVR/content.js` - Scholar page logic, ranking flow, summary panel, search dialog, About dialog
- `GSVR/inject.css` - injected Scholar UI styling
- `GSVR/rank_core.js` - shared ranking and matching logic
- `GSVR/venue_data.js` - venue aliases and proceedings/journal mapping data
- `GSVR/popup.*` - popup UI
- `GSVR/options.*` - full settings UI
- `GSVR/core/` - bundled CORE snapshots
- `GSVR/sjr/` - yearly official SCImago CSV files
- `GSVR/data/sjr-index.json` - compact generated SJR lookup index
- `GSVR/tests/` - unit tests, benchmark runner, fixtures, and reports
- `scripts/` - build, clean, zip, and SJR-index generation scripts
- `dist/` - build output created by `npm run build`

## Data sources

The extension relies on three main authority sources:

- [DBLP](https://dblp.org/) for publication and venue metadata
- [CORE Conference Rankings](https://portal.core.edu.au/conf-ranks/) for conference ranks
- [SCImago Journal Rank](https://www.scimagojr.com/journalrank.php) for journal quartiles

Current bundled data coverage in this repository:

- CORE snapshots: `2014`, `2017`, `2018`, `2020`, `2021`, `2023`, `2026`
- SJR CSVs: `2010` through `2024`

As of April 2026, this repository does not bundle an official `2025` SJR CSV.

## Limitations

- Papers missing from DBLP may remain unranked or appear as `DBLP Missing`.
- Some venues are genuinely ambiguous and are intentionally left unresolved.
- Ranking policies in research are field-specific; GSVR focuses on DBLP plus CORE plus SJR rather than trying to aggregate every ranking system.
- The extension is designed for Google Scholar profile pages, not as a general-purpose citation-site rank overlay.

## Contributing and bug reports

Issues and pull requests are welcome.

If you report a ranking problem, please include:

- the Google Scholar profile URL
- the specific paper title
- the expected venue/rank behavior
- screenshots if the UI is involved
- console output if you are debugging locally

You can also use the in-product `Report` action from the summary panel.

## License

This project is licensed under the MIT License.

If the extension is useful to you, starring the repository helps more researchers find it.
