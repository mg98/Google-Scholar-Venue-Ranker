# Accuracy Benchmark Report

- Generated: 2026-05-07T06:38:59.305Z
- Suite: `gold`
- Family: all families
- Fixtures: 600
- JSON artifact: `C:\Users\Naveed Bhatti\Documents\Google-Scholar-Venue-Ranker - CODEX\GSVR\tests\fixtures\accuracy\reports\accuracy-gold.json`
- HTML artifact: `C:\Users\Naveed Bhatti\Documents\Google-Scholar-Venue-Ranker - CODEX\GSVR\tests\fixtures\accuracy\reports\accuracy-gold.html`

## gold

| Family | Total | Pass | Accuracy | Precision | Recall | Abstain | Ambiguous | Mean | P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| conference_resolution | 120 | 120 | 100.0% | 100.0% | 100.0% | 2.5% | 1.7% | 0.26ms | 0.12ms |
| journal_resolution | 120 | 120 | 100.0% | 100.0% | 100.0% | 2.5% | 0.0% | 12.01ms | 0.09ms |
| pipeline_e2e | 100 | 100 | 100.0% | 100.0% | 100.0% | 10.0% | 5.0% | 0.33ms | 2.80ms |
| profile_match | 40 | 40 | 100.0% | 100.0% | 100.0% | 50.0% | 0.0% | 0.37ms | 0.99ms |
| publication_match | 80 | 80 | 100.0% | 100.0% | 100.0% | 50.0% | 25.0% | 0.05ms | 0.12ms |
| search_queries | 60 | 60 | 100.0% | 100.0% | 100.0% | 68.3% | 1.7% | 61.84ms | 5.72ms |
| track_classification | 80 | 80 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0.03ms | 0.02ms |

### conference_resolution

### Status Confusion

| Expected \ Actual | ambiguous | matched | missing | unranked |
| --- | --- | --- | --- | --- |
| ambiguous | 2 | 0 | 0 | 0 |
| matched | 0 | 109 | 0 | 0 |
| missing | 0 | 0 | 1 | 0 |
| unranked | 0 | 0 | 0 | 8 |

### Conference Rank Confusion

| Expected \ Actual | A | A* | B | C | N/A |
| --- | --- | --- | --- | --- | --- |
| A | 27 | 0 | 0 | 0 | 0 |
| A* | 0 | 40 | 0 | 0 | 0 |
| B | 0 | 0 | 26 | 0 | 0 |
| C | 0 | 0 | 0 | 16 | 0 |
| N/A | 0 | 0 | 0 | 0 | 11 |

### journal_resolution

### Status Confusion

| Expected \ Actual | matched | missing |
| --- | --- | --- |
| matched | 117 | 0 |
| missing | 0 | 3 |

### Journal Quartile Confusion

| Expected \ Actual | N/A | Q1 | Q2 | Q3 | Q4 |
| --- | --- | --- | --- | --- | --- |
| N/A | 3 | 0 | 0 | 0 | 0 |
| Q1 | 0 | 31 | 0 | 0 | 0 |
| Q2 | 0 | 0 | 25 | 0 | 0 |
| Q3 | 0 | 0 | 0 | 17 | 0 |
| Q4 | 0 | 0 | 0 | 0 | 44 |

### pipeline_e2e

### Status Confusion

| Expected \ Actual | ambiguous | matched | missing | unranked |
| --- | --- | --- | --- | --- |
| ambiguous | 5 | 0 | 0 | 0 |
| matched | 0 | 50 | 0 | 0 |
| missing | 0 | 0 | 5 | 0 |
| unranked | 0 | 0 | 0 | 40 |

### profile_match

### Status Confusion

| Expected \ Actual | matched | missing |
| --- | --- | --- |
| matched | 20 | 0 |
| missing | 0 | 20 |

### publication_match

### Status Confusion

| Expected \ Actual | ambiguous | matched | missing |
| --- | --- | --- | --- |
| ambiguous | 20 | 0 | 0 |
| matched | 0 | 40 | 0 |
| missing | 0 | 0 | 20 |

### search_queries

### Status Confusion

| Expected \ Actual | ambiguous | matched | missing | unranked |
| --- | --- | --- | --- | --- |
| ambiguous | 1 | 0 | 0 | 0 |
| matched | 0 | 17 | 0 | 0 |
| missing | 0 | 0 | 40 | 0 |
| unranked | 0 | 0 | 0 | 2 |

### track_classification

### Status Confusion

| Expected \ Actual | demoPoster | extendedAbstract | main | shortPaper | workshop |
| --- | --- | --- | --- | --- | --- |
| demoPoster | 20 | 0 | 0 | 0 | 0 |
| extendedAbstract | 0 | 20 | 0 | 0 | 0 |
| main | 0 | 0 | 10 | 0 | 0 |
| shortPaper | 0 | 0 | 0 | 10 | 0 |
| workshop | 0 | 0 | 0 | 0 | 20 |
