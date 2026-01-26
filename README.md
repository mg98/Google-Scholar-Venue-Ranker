![Version 1.8.5](https://img.shields.io/badge/version-1.8.5-blue.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/egohghgpljdhkmcmllhncfndmkeilpfb?label=Chrome%20Web%20Store&style=flat-square)](https://chromewebstore.google.com/detail/egohghgpljdhkmcmllhncfndmkeilpfb?utm_source=item-share-cb)

# Google Scholar Venue Ranker (GSVR)

**Instantly see CORE conference rankings and SJR journal quartiles directly on Google Scholar profile pages—essential context for researchers in Computer Science, Electrical Engineering, and related fields.**

This Chrome extension enhances your Google Scholar experience by automatically fetching and displaying:
- **CORE / iCORE Conference Rankings** for conference publications (rank chosen by publication year)
- **SCImago Journal Rank (SJR)** quartiles (Q1–Q4) for journals (by publication year)

![Screenshot of Extension in Action](GSVR/images/Screenshot.png)

<p align="left">
  <a href="https://chromewebstore.google.com/detail/egohghgpljdhkmcmllhncfndmkeilpfb?utm_source=item-share-cb">
    <img src="https://developer.chrome.com/static/docs/webstore/branding/image/UV4C4ybeBTsZt43U4xis.png" alt="Available in the Chrome Web Store">
  </a>
</p>

## What's New (v1.8.5)

- **iCORE 2026 rankings are included and supported** (ships with `CORE_2026.json` and is used for 2026+ lookups).
- **Rank searching is now supported for both conferences and journals** via an in-page search overlay (CORE tiers / SJR quartiles).
- **New status/diagnostic badges** make edge-cases explicit (short papers, demo/poster tracks, missing DBLP entries).

---

## Features

| Feature | Description |
| --- | --- |
| 🎯 **Historical matching (CORE / iCORE)** | Selects the appropriate CORE ranking list (**2026, 2023, 2021, 2020, 2018, 2017, 2014**) based on publication year and applies multiple heuristics for matching. |
| 🏷 **Rank badges (CORE)** | Shows color-coded A\*, A, B, C badges inline next to each conference paper title to reflect historical rank. |
| 📚 **Journal insights (SJR)** | Adds SJR quartile badges (Q1–Q4) next to journal papers using local SCImago datasets. |
| 🔎 **Rank search (Conference + Journal)** | Open the **Search Ranking (CORE / SJR)** overlay and search a venue by **name or acronym** (e.g., SIGCOMM, TPAMI) for either **conference CORE tiers** or **journal SJR quartiles**. |
| 🧭 **DBLP-assisted matching** | Uses DBLP publication metadata to detect venues, normalize names, and improve disambiguation (including workshop/demo/poster detection). |
| 📊 **Summary panel** | Totals conference ranks (A\*, A, B, C, N/A) and SJR quartiles, aggregated across processed publications. |

---

## Status badges

In addition to standard CORE and SJR badges, the extension can emit **neutral status badges** to explain why a paper is shown as **N/A** or why it was skipped in strict DBLP-only matching.

### New status/diagnostic badges (v1.8.5)

![N/A → short paper](https://img.shields.io/badge/N%2FA%20%E2%86%92-short%20paper-f0f0f0?style=flat-square&labelColor=bdbdbd&color=f0f0f0) ![N/A → demo paper](https://img.shields.io/badge/N%2FA%20%E2%86%92-demo%20paper-f0f0f0?style=flat-square&labelColor=bdbdbd&color=f0f0f0) ![N/A → poster paper](https://img.shields.io/badge/N%2FA%20%E2%86%92-poster%20paper-f0f0f0?style=flat-square&labelColor=bdbdbd&color=f0f0f0) ![DBLP Entry Missing](https://img.shields.io/badge/DBLP-Entry%20Missing-e2e8f0?style=flat-square&labelColor=94a3b8&color=e2e8f0)

- **N/A → short paper**: conference entry is detected as a short paper (strictly **< 6 pages** when page ranges are available via DBLP).
- **N/A → demo paper / poster paper**: entry is detected as a demo/poster/companion/abstract-style track (keyword-based detection using DBLP/venue/title signals).
- **DBLP Entry Missing**: in **strict DBLP-only** mode, the Scholar entry could not be matched to the selected/matched DBLP profile, so the extension flags it rather than inferring a venue rank.

Additional neutral statuses may also appear, for example:

![N/A → workshop](https://img.shields.io/badge/N%2FA%20%E2%86%92-workshop-f0f0f0?style=flat-square&labelColor=bdbdbd&color=f0f0f0)

- **N/A → workshop**: workshop tracks do not inherit a parent conference rank unless explicitly enabled.

---

## Quick install

### Option A — Chrome Web Store

Install from the Chrome Web Store (link above).

### Option B — Manual install (ZIP / source)

1. **Download** a release ZIP from GitHub Releases (or click **Code → Download ZIP** on GitHub and extract).
2. **Load the extension in Chrome**:
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked**
   - Select the folder that contains `manifest.json`:
     - If your ZIP contains a **`GSVR/`** folder, select **`GSVR/`**.
     - If your ZIP contains a **`dist/`** folder, select **`dist/`**.
3. **Verify**:
   - Open a Scholar profile page (e.g., `https://scholar.google.com/citations?user=...`).
   - The extension should automatically run. You should see the progress bar, then the summary panel, and ranks next to papers.

---

## How to use rank search (conference + journal)

1. Open any Google Scholar profile page.
2. In the summary panel footer, click the **🔍 Search** icon (**Search Ranking (CORE / SJR)**).
3. Choose **Conference** or **Journal/Transaction**, enter a venue name/acronym, optionally pick a year, and press **Search**.

> The search is **local/offline** (it uses the packaged CORE/iCORE and SJR datasets), so results are fast and consistent.

---

## Build locally (for development)

### Prerequisites

- **Node.js 18+**

### Build

From the repo root:

```bash
npm install
npm run build
```

This creates a clean, loadable extension at `./dist/`.

Load it via **chrome://extensions → Load unpacked → select `dist/`**.

### Test

```bash
npm test
```

---

## Repository layout

- `GSVR/` — extension source (contains `manifest.json`, scripts, datasets)
- `dist/` — build output produced by `npm run build` (safe to load unpacked)
- `scripts/` — build/clean scripts used by npm

---

## Limitations & troubleshooting

- **DBLP coverage** — publications missing from DBLP may not be ranked and can be flagged as ![DBLP Entry Missing](https://img.shields.io/badge/DBLP-Entry%20Missing-e2e8f0?style=flat-square&labelColor=94a3b8&color=e2e8f0).
- **Short/demo/poster tracks** — some conference entries are intentionally excluded from CORE ranking and may show as:
  - ![N/A → short paper](https://img.shields.io/badge/N%2FA%20%E2%86%92-short%20paper-f0f0f0?style=flat-square&labelColor=bdbdbd&color=f0f0f0)
  - ![N/A → demo paper](https://img.shields.io/badge/N%2FA%20%E2%86%92-demo%20paper-f0f0f0?style=flat-square&labelColor=bdbdbd&color=f0f0f0)
  - ![N/A → poster paper](https://img.shields.io/badge/N%2FA%20%E2%86%92-poster%20paper-f0f0f0?style=flat-square&labelColor=bdbdbd&color=f0f0f0)
  - ![N/A → workshop](https://img.shields.io/badge/N%2FA%20%E2%86%92-workshop-f0f0f0?style=flat-square&labelColor=bdbdbd&color=f0f0f0)
- **Name mismatches** — DBLP may list your papers under a different name, leading to profile mismatches.

Tips:

- Verify your DBLP profile is correct and matches your Scholar name.
- Use the extension’s **Report Bug** link (in the summary panel) and include:
  - The Google Scholar profile URL
  - The specific paper/venue that was mismatched or not detected
  - The expected rank/behavior
  - Any console errors (if applicable)

If you’re debugging locally, open Chrome DevTools → **Console** on the Scholar page to see matching logs.

---

## Data sources & acknowledgements

This extension uses historical **CORE / iCORE Conference Rankings** from **2026, 2023, 2021, 2020, 2018, 2017, and 2014**, and **SCImago Journal Rank (SJR)** data from [scimagojr.com](https://www.scimagojr.com/) (stored locally under `GSVR/sjr/`). It also uses **DBLP** metadata to identify venues and expand abbreviated journal names.

Please refer to the official [CORE portal](http://portal.core.edu.au/conf-ranks/) and [SCImago portal](https://www.scimagojr.com/journalrank.php) for the most authoritative data.

---

## Contributing & bug reports (BETA)

This extension is currently in BETA. Your feedback is invaluable!

- **Report a bug:** use the **Report Bug** link in the summary panel or open an issue on GitHub. When reporting, please include:
  - The Google Scholar profile URL
  - The specific paper/venue that was mismatched or not detected
  - The expected rank/behavior
  - Any console errors (if applicable)
- **Feature requests:** open an issue.
- **Pull requests:** contributions are welcome—please open an issue first to discuss significant changes.

---

## Future ideas

- Support for other ranking systems (e.g., Qualis, CCF).
- User-configurable settings (e.g., preferred ranking system, option to hide N/A).
- More advanced venue name disambiguation.

---

## License

This project is licensed under the MIT License.

⭐ **Like it?** Give the repo a star—helps other researchers discover the extension!
