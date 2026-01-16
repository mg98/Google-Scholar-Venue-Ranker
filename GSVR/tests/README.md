# Tests

Run from the repository root:

```bash
node tests/run_tests.js
```

These tests cover:
- Deterministic DBLP title matching tie-breaks
- Workshop vs parent-conference disambiguation signals (e.g., `ENSsys@SenSys`)
- Demo/Poster track detection (e.g., PhD Forum abstracts)
- Short-paper detection from page ranges (<6 pages)
- Venue normalization (e.g., `MobiQuitous (2)` → `mobiquitous`)
