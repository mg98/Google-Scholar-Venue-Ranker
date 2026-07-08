# Accuracy Benchmark Report

- Generated: 2026-07-08T13:15:29.992Z
- Suite: `all`
- Family: all families
- Fixtures: 2180
- JSON artifact: `/home/user/Google-Scholar-Venue-Ranker/GSVR/tests/fixtures/accuracy/reports/accuracy-all.json`
- HTML artifact: `/home/user/Google-Scholar-Venue-Ranker/GSVR/tests/fixtures/accuracy/reports/accuracy-all.html`

## gold

| Family | Total | Pass | Accuracy | Precision | Recall | Abstain | Review | Mean | P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| conference_resolution | 120 | 120 | 100.0% | 100.0% | 100.0% | 5.0% | 1.7% | 2.49ms | 0.37ms |
| journal_resolution | 120 | 120 | 100.0% | 100.0% | 100.0% | 2.5% | 0.0% | 4.07ms | 0.20ms |
| pipeline_e2e | 100 | 100 | 100.0% | 100.0% | 100.0% | 15.0% | 5.0% | 0.64ms | 3.24ms |
| profile_match | 40 | 40 | 100.0% | 100.0% | 100.0% | 50.0% | 0.0% | 0.45ms | 1.44ms |
| publication_match | 80 | 80 | 100.0% | 100.0% | 100.0% | 50.0% | 25.0% | 0.06ms | 0.12ms |
| search_queries | 60 | 60 | 100.0% | 100.0% | 100.0% | 73.3% | 1.7% | 10.79ms | 24.81ms |
| track_classification | 80 | 80 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0.04ms | 0.07ms |

### conference_resolution

### Status Confusion

| Expected \ Actual | matched | missing | review |
| --- | --- | --- | --- |
| matched | 114 | 0 | 0 |
| missing | 0 | 4 | 0 |
| review | 0 | 0 | 2 |

### Conference Rank Confusion

| Expected \ Actual | A | A* | B | C | N/A |
| --- | --- | --- | --- | --- | --- |
| A | 27 | 0 | 0 | 0 | 0 |
| A* | 0 | 41 | 0 | 0 | 0 |
| B | 0 | 0 | 28 | 0 | 0 |
| C | 0 | 0 | 0 | 18 | 0 |
| N/A | 0 | 0 | 0 | 0 | 6 |

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
| Q1 | 0 | 30 | 0 | 0 | 0 |
| Q2 | 0 | 0 | 18 | 0 | 0 |
| Q3 | 0 | 0 | 0 | 21 | 0 |
| Q4 | 0 | 0 | 0 | 0 | 48 |

### pipeline_e2e

### Status Confusion

| Expected \ Actual | matched | missing | review | unranked |
| --- | --- | --- | --- | --- |
| matched | 50 | 0 | 0 | 0 |
| missing | 0 | 10 | 0 | 0 |
| review | 0 | 0 | 5 | 0 |
| unranked | 0 | 0 | 0 | 35 |

### profile_match

### Status Confusion

| Expected \ Actual | matched | missing |
| --- | --- | --- |
| matched | 20 | 0 |
| missing | 0 | 20 |

### publication_match

### Status Confusion

| Expected \ Actual | matched | missing | review |
| --- | --- | --- | --- |
| matched | 40 | 0 | 0 |
| missing | 0 | 20 | 0 |
| review | 0 | 0 | 20 |

### search_queries

### Status Confusion

| Expected \ Actual | matched | missing | review |
| --- | --- | --- | --- |
| matched | 16 | 0 | 0 |
| missing | 0 | 43 | 0 |
| review | 0 | 0 | 1 |

### track_classification

### Status Confusion

| Expected \ Actual | demoPoster | extendedAbstract | main | shortPaper | workshop |
| --- | --- | --- | --- | --- | --- |
| demoPoster | 20 | 0 | 0 | 0 | 0 |
| extendedAbstract | 0 | 20 | 0 | 0 | 0 |
| main | 0 | 0 | 10 | 0 | 0 |
| shortPaper | 0 | 0 | 0 | 10 | 0 |
| workshop | 0 | 0 | 0 | 0 | 20 |

## shadow

| Family | Total | Pass | Accuracy | Precision | Recall | Abstain | Review | Mean | P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| conference_resolution | 900 | 900 | 100.0% | 100.0% | 100.0% | 0.2% | 0.2% | 0.04ms | 0.09ms |
| journal_resolution | 320 | 320 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0.07ms | 0.12ms |
| pipeline_e2e | 240 | 240 | 100.0% | 100.0% | 100.0% | 52.9% | 2.1% | 1.86ms | 3.92ms |
| search_queries | 120 | 120 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 1.19ms | 2.24ms |

### conference_resolution

### Status Confusion

| Expected \ Actual | matched | review |
| --- | --- | --- |
| matched | 898 | 0 |
| review | 0 | 2 |

### Conference Rank Confusion

| Expected \ Actual | A | A* | B | C | N/A |
| --- | --- | --- | --- | --- | --- |
| A | 140 | 0 | 0 | 0 | 0 |
| A* | 0 | 88 | 0 | 0 | 0 |
| B | 0 | 0 | 300 | 0 | 0 |
| C | 0 | 0 | 0 | 370 | 0 |
| N/A | 0 | 0 | 0 | 0 | 2 |

### journal_resolution

### Status Confusion

| Expected \ Actual | matched |
| --- | --- |
| matched | 320 |

### Journal Quartile Confusion

| Expected \ Actual | Q1 | Q2 | Q3 | Q4 |
| --- | --- | --- | --- | --- |
| Q1 | 292 | 0 | 0 | 0 |
| Q2 | 0 | 22 | 0 | 0 |
| Q3 | 0 | 0 | 3 | 0 |
| Q4 | 0 | 0 | 0 | 3 |

### pipeline_e2e

### Status Confusion

| Expected \ Actual | matched | missing | review | unranked |
| --- | --- | --- | --- | --- |
| matched | 72 | 0 | 0 | 0 |
| missing | 0 | 122 | 0 | 0 |
| review | 0 | 0 | 5 | 0 |
| unranked | 0 | 0 | 0 | 41 |

### search_queries

### Status Confusion

| Expected \ Actual | matched |
| --- | --- |
| matched | 120 |
