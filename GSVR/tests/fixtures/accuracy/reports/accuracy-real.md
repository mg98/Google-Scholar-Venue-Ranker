# Accuracy Benchmark Report

- Generated: 2026-06-11T04:34:34.994Z
- Suite: `real`
- Family: all families
- Fixtures: 91
- JSON artifact: `C:\Users\Naveed Bhatti\Documents\Google-Scholar-Venue-Ranker - CODEX\GSVR\tests\fixtures\accuracy\reports\accuracy-real.json`
- HTML artifact: `C:\Users\Naveed Bhatti\Documents\Google-Scholar-Venue-Ranker - CODEX\GSVR\tests\fixtures\accuracy\reports\accuracy-real.html`

## real

| Family | Total | Pass | Accuracy | Precision | Recall | Abstain | Ambiguous | Mean | P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| conference_resolution | 27 | 27 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 7.96ms | 45.62ms |
| journal_resolution | 54 | 54 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 15.43ms | 1.74ms |
| publication_match | 4 | 4 | 100.0% | 100.0% | 100.0% | 25.0% | 25.0% | 3.62ms | 13.50ms |
| track_classification | 6 | 6 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0.38ms | 1.51ms |

### conference_resolution

### Status Confusion

| Expected \ Actual | matched | unranked |
| --- | --- | --- |
| matched | 24 | 0 |
| unranked | 0 | 3 |

### Conference Rank Confusion

| Expected \ Actual | A | A* | B | N/A |
| --- | --- | --- | --- | --- |
| A | 5 | 0 | 0 | 0 |
| A* | 0 | 18 | 0 | 0 |
| B | 0 | 0 | 1 | 0 |
| N/A | 0 | 0 | 0 | 3 |

### journal_resolution

### Status Confusion

| Expected \ Actual | matched | unranked |
| --- | --- | --- |
| matched | 53 | 0 |
| unranked | 0 | 1 |

### Journal Quartile Confusion

| Expected \ Actual | N/A | Q1 | Q2 | Q3 | Q4 |
| --- | --- | --- | --- | --- | --- |
| N/A | 1 | 0 | 0 | 0 | 0 |
| Q1 | 0 | 43 | 0 | 0 | 0 |
| Q2 | 0 | 0 | 7 | 0 | 0 |
| Q3 | 0 | 0 | 0 | 2 | 0 |
| Q4 | 0 | 0 | 0 | 0 | 1 |

### publication_match

### Status Confusion

| Expected \ Actual | ambiguous | matched |
| --- | --- | --- |
| ambiguous | 1 | 0 |
| matched | 0 | 3 |

### track_classification

### Status Confusion

| Expected \ Actual | demoPoster | extendedAbstract | main | shortPaper | workshop |
| --- | --- | --- | --- | --- | --- |
| demoPoster | 1 | 0 | 0 | 0 | 0 |
| extendedAbstract | 0 | 1 | 0 | 0 | 0 |
| main | 0 | 0 | 2 | 0 | 0 |
| shortPaper | 0 | 0 | 0 | 1 | 0 |
| workshop | 0 | 0 | 0 | 0 | 1 |
