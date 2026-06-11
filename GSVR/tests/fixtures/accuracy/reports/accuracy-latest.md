# Accuracy Benchmark Report

- Generated: 2026-06-11T04:37:19.846Z
- Suite: `all`
- Family: all families
- Fixtures: 2271
- JSON artifact: `C:\Users\Naveed Bhatti\Documents\Google-Scholar-Venue-Ranker - CODEX\GSVR\tests\fixtures\accuracy\reports\accuracy-all.json`
- HTML artifact: `C:\Users\Naveed Bhatti\Documents\Google-Scholar-Venue-Ranker - CODEX\GSVR\tests\fixtures\accuracy\reports\accuracy-all.html`

## gold

| Family | Total | Pass | Accuracy | Precision | Recall | Abstain | Ambiguous | Mean | P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| conference_resolution | 120 | 120 | 100.0% | 100.0% | 100.0% | 2.5% | 1.7% | 0.38ms | 0.26ms |
| journal_resolution | 120 | 120 | 100.0% | 100.0% | 100.0% | 2.5% | 0.0% | 7.95ms | 0.24ms |
| pipeline_e2e | 100 | 100 | 100.0% | 100.0% | 100.0% | 10.0% | 5.0% | 0.43ms | 3.51ms |
| profile_match | 40 | 40 | 100.0% | 100.0% | 100.0% | 50.0% | 0.0% | 0.47ms | 1.24ms |
| publication_match | 80 | 80 | 100.0% | 100.0% | 100.0% | 50.0% | 25.0% | 0.04ms | 0.06ms |
| search_queries | 60 | 60 | 100.0% | 100.0% | 100.0% | 68.3% | 1.7% | 8.19ms | 4.01ms |
| track_classification | 80 | 80 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0.03ms | 0.05ms |

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
| Q1 | 0 | 28 | 0 | 0 | 0 |
| Q2 | 0 | 0 | 19 | 0 | 0 |
| Q3 | 0 | 0 | 0 | 21 | 0 |
| Q4 | 0 | 0 | 0 | 0 | 49 |

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

## shadow

| Family | Total | Pass | Accuracy | Precision | Recall | Abstain | Ambiguous | Mean | P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| conference_resolution | 900 | 900 | 100.0% | 100.0% | 100.0% | 0.6% | 0.6% | 0.02ms | 0.05ms |
| journal_resolution | 320 | 320 | 100.0% | 100.0% | 100.0% | 0.3% | 0.3% | 0.06ms | 0.10ms |
| pipeline_e2e | 240 | 240 | 100.0% | 100.0% | 100.0% | 50.8% | 2.1% | 2.58ms | 7.02ms |
| search_queries | 120 | 120 | 100.0% | 100.0% | 100.0% | 0.8% | 0.8% | 1.53ms | 5.44ms |

### conference_resolution

### Status Confusion

| Expected \ Actual | ambiguous | matched | unranked |
| --- | --- | --- | --- |
| ambiguous | 5 | 0 | 0 |
| matched | 0 | 749 | 0 |
| unranked | 0 | 0 | 146 |

### Conference Rank Confusion

| Expected \ Actual | A | A* | B | C | N/A |
| --- | --- | --- | --- | --- | --- |
| A | 123 | 0 | 0 | 0 | 0 |
| A* | 0 | 84 | 0 | 0 | 0 |
| B | 0 | 0 | 251 | 0 | 0 |
| C | 0 | 0 | 0 | 291 | 0 |
| N/A | 0 | 0 | 0 | 0 | 151 |

### journal_resolution

### Status Confusion

| Expected \ Actual | ambiguous | matched |
| --- | --- | --- |
| ambiguous | 1 | 0 |
| matched | 0 | 319 |

### Journal Quartile Confusion

| Expected \ Actual | N/A | Q1 | Q2 | Q3 | Q4 |
| --- | --- | --- | --- | --- | --- |
| N/A | 1 | 0 | 0 | 0 | 0 |
| Q1 | 0 | 109 | 0 | 0 | 0 |
| Q2 | 0 | 0 | 66 | 0 | 0 |
| Q3 | 0 | 0 | 0 | 66 | 0 |
| Q4 | 0 | 0 | 0 | 0 | 78 |

### pipeline_e2e

### Status Confusion

| Expected \ Actual | ambiguous | matched | missing | unranked |
| --- | --- | --- | --- | --- |
| ambiguous | 5 | 0 | 0 | 0 |
| matched | 0 | 72 | 0 | 0 |
| missing | 0 | 0 | 117 | 0 |
| unranked | 0 | 0 | 0 | 46 |

### search_queries

### Status Confusion

| Expected \ Actual | ambiguous | matched | unranked |
| --- | --- | --- | --- |
| ambiguous | 1 | 0 | 0 |
| matched | 0 | 106 | 0 |
| unranked | 0 | 0 | 13 |

## real

| Family | Total | Pass | Accuracy | Precision | Recall | Abstain | Ambiguous | Mean | P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| conference_resolution | 27 | 27 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0.02ms | 0.08ms |
| journal_resolution | 54 | 54 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0.13ms | 0.42ms |
| publication_match | 4 | 4 | 100.0% | 100.0% | 100.0% | 25.0% | 25.0% | 0.10ms | 0.30ms |
| track_classification | 6 | 6 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0.01ms | 0.03ms |

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
