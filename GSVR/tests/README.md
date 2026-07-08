# Tests

Run from the repository root:

```bash
npm test
```

These tests cover:
- Deterministic DBLP title matching tie-breaks
- Workshop vs parent-conference disambiguation signals (e.g., `ENSsys@SenSys`)
- Demo/Poster track detection (e.g., PhD Forum abstracts)
- Short-paper detection from page ranges (<6 pages)
- Venue normalization (e.g., `MobiQuitous (2)` → `mobiquitous`)
- Timeline range filtering for `Full Timeline` and `Last 10 Years`
- CORE/SJR rank-count recomputation from filtered publication sets
- Fixed-window and full-timeline histogram year filling
- Focused `A*/A` CORE and `Q1` journal histogram generation
- Stacked horizontal report chart layout with uncropped rotated year labels
- Historical SJR coverage behavior for pre-1999 journal papers

Score-model tests can also be run directly:

```bash
npm run test:score
```

Before packaging a GitHub or Chrome Web Store release, run:

```bash
npm test
npm run test:score
npm run build
```

Accuracy benchmark workflow:

```bash
npm run benchmark:accuracy:fixtures
npm run benchmark:accuracy -- --suite gold
npm run benchmark:accuracy -- --suite all --write-baseline
```

The accuracy benchmark emits:
- per-family accuracy, precision, recall, abstain rate, review rate, and latency
- status confusion matrices for `matched / unranked / review / missing`
- conference rank and journal quartile confusion tables
- machine-readable JSON via `--json`
- human-readable Markdown and HTML artifacts under `GSVR/tests/fixtures/accuracy/reports/`
- optional regression checks against `GSVR/tests/fixtures/accuracy/baseline.json`
