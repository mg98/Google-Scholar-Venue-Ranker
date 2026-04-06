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

Accuracy benchmark workflow:

```bash
npm run benchmark:accuracy:fixtures
npm run benchmark:accuracy -- --suite gold
npm run benchmark:accuracy -- --suite all --write-baseline
```

The accuracy benchmark emits:
- per-family accuracy, precision, recall, abstain rate, ambiguity rate, and latency
- status confusion matrices for `matched / unranked / ambiguous / missing`
- conference rank and journal quartile confusion tables
- machine-readable JSON via `--json`
- human-readable Markdown and HTML artifacts under `GSVR/tests/fixtures/accuracy/reports/`
- optional regression checks against `GSVR/tests/fixtures/accuracy/baseline.json`
