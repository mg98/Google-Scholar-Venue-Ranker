# Accuracy Benchmark Report

- Generated: 2026-07-08T09:59:44.031Z
- Suite: `all`
- Family: all families
- Fixtures: 2180
- JSON artifact: `/Users/marcel/Downloads/corematch/Google-Scholar-Venue-Ranker/GSVR/tests/fixtures/accuracy/reports/accuracy-all.json`
- HTML artifact: `/Users/marcel/Downloads/corematch/Google-Scholar-Venue-Ranker/GSVR/tests/fixtures/accuracy/reports/accuracy-all.html`

## Gating Issues

- Gold fixtures failed in conference_resolution: 9
- Gold fixtures failed in journal_resolution: 115
- Gold fixtures failed in pipeline_e2e: 9
- Gold fixtures failed in search_queries: 3

## Top Regressions

- `gold/conference_resolution/gold-conference-acronym-08`
- `gold/conference_resolution/gold-conference-title-08`
- `gold/conference_resolution/gold-conference-acronym-17`
- `gold/conference_resolution/gold-conference-title-17`
- `gold/conference_resolution/gold-conference-acronym-26`
- `gold/conference_resolution/gold-conference-title-26`
- `gold/conference_resolution/gold-conference-sensys-merged`
- `gold/conference_resolution/gold-conference-ubicomp-journal-published`
- `gold/conference_resolution/gold-conference-nsdi-fallback`
- `gold/journal_resolution/gold-journal-exact-01`
- `gold/journal_resolution/gold-journal-exact-02`
- `gold/journal_resolution/gold-journal-exact-03`
- `gold/journal_resolution/gold-journal-exact-04`
- `gold/journal_resolution/gold-journal-exact-05`
- `gold/journal_resolution/gold-journal-exact-06`
- `gold/journal_resolution/gold-journal-exact-07`
- `gold/journal_resolution/gold-journal-exact-08`
- `gold/journal_resolution/gold-journal-exact-09`
- `gold/journal_resolution/gold-journal-exact-10`
- `gold/pipeline_e2e/gold-pipeline-sjr-02`

## gold

| Family | Total | Pass | Accuracy | Precision | Recall | Abstain | Review | Mean | P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| conference_resolution | 120 | 111 | 92.5% | 100.0% | 99.1% | 10.0% | 1.7% | 1.16ms | 1.41ms |
| journal_resolution | 120 | 5 | 4.2% | 100.0% | 74.4% | 27.5% | 0.0% | 11.69ms | 62.30ms |
| pipeline_e2e | 100 | 91 | 91.0% | 100.0% | 92.0% | 19.0% | 5.0% | 0.29ms | 1.47ms |
| profile_match | 40 | 40 | 100.0% | 100.0% | 100.0% | 50.0% | 0.0% | 0.29ms | 0.53ms |
| publication_match | 80 | 80 | 100.0% | 100.0% | 100.0% | 50.0% | 25.0% | 0.03ms | 0.05ms |
| search_queries | 60 | 57 | 95.0% | 100.0% | 94.1% | 73.3% | 1.7% | 4.42ms | 5.57ms |
| track_classification | 80 | 80 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0.02ms | 0.01ms |

### conference_resolution

### Status Confusion

| Expected \ Actual | matched | missing | review |
| --- | --- | --- | --- |
| matched | 108 | 1 | 0 |
| missing | 0 | 1 | 0 |
| review | 0 | 0 | 2 |
| unranked | 0 | 8 | 0 |

### Conference Rank Confusion

| Expected \ Actual | A | A* | B | C | N/A |
| --- | --- | --- | --- | --- | --- |
| A | 27 | 0 | 0 | 0 | 0 |
| A* | 0 | 39 | 0 | 0 | 1 |
| B | 0 | 0 | 26 | 0 | 0 |
| C | 0 | 0 | 0 | 16 | 0 |
| N/A | 0 | 0 | 0 | 0 | 11 |

### Sample Failures

- `gold-conference-acronym-08` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM Conference on Embedded Networked Sensor Systems","rawRankLabel":"unranked: merged","sourceYear":2026}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM Conference on Embedded Networked Sensor Systems"}`
- `gold-conference-title-08` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM Conference on Embedded Networked Sensor Systems","rawRankLabel":"unranked: merged","sourceYear":2026}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM Conference on Embedded Networked Sensor Systems"}`
- `gold-conference-acronym-17` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM International Conference on Interactive Surfaces and Spaces (was International Workshop on Horizontal Interactive Human-Computer Systems: Tabletop)","rawRankLabel":"Journal Published","sourceYear":2026}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM International Conference on Interactive Surfaces and Spaces (was International Workshop on Horizontal Interactive Human-Computer Systems: Tabletop)"}`
- `gold-conference-title-17` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM International Conference on Interactive Surfaces and Spaces (was International Workshop on Horizontal Interactive Human-Computer Systems: Tabletop)","rawRankLabel":"Journal Published","sourceYear":2026}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM International Conference on Interactive Surfaces and Spaces (was International Workshop on Horizontal Interactive Human-Computer Systems: Tabletop)"}`
- `gold-conference-acronym-26` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM International Joint Conference on Pervasive and Ubiquitous Computing (PERVASIVE and UbiComp combined from 2013)","rawRankLabel":"journal published","sourceYear":2026}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM International Joint Conference on Pervasive and Ubiquitous Computing (PERVASIVE and UbiComp combined from 2013)"}`
- `gold-conference-title-26` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM International Joint Conference on Pervasive and Ubiquitous Computing (PERVASIVE and UbiComp combined from 2013)","rawRankLabel":"journal published","sourceYear":2026}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM International Joint Conference on Pervasive and Ubiquitous Computing (PERVASIVE and UbiComp combined from 2013)"}`
- `gold-conference-sensys-merged` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM Conference on Embedded Networked Sensor Systems","rawRankLabel":"unranked: merged","matchType":"acronym_exact","sourceYear":2026}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"SenSys"}`
- `gold-conference-ubicomp-journal-published` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM International Joint Conference on Pervasive and Ubiquitous Computing (PERVASIVE and UbiComp combined from 2013)","rawRankLabel":"journal published","matchType":"acronym_exact","sourceYear":2026}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"UbiComp"}`
- `gold-conference-nsdi-fallback` expected `{"status":"matched","rank":"A*","matchedVenue":"Symposium on Networked Systems, Design and Implementation","rawRankLabel":null,"matchType":"top_venue_fallback","sourceYear":2026}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"NSDI"}`

### journal_resolution

### Status Confusion

| Expected \ Actual | matched | missing |
| --- | --- | --- |
| matched | 87 | 30 |
| missing | 0 | 3 |

### Journal Quartile Confusion

| Expected \ Actual | N/A | Q1 | Q2 | Q3 | Q4 |
| --- | --- | --- | --- | --- | --- |
| N/A | 3 | 0 | 0 | 0 | 0 |
| Q1 | 9 | 19 | 0 | 0 | 0 |
| Q2 | 3 | 1 | 14 | 0 | 1 |
| Q3 | 8 | 0 | 0 | 13 | 0 |
| Q4 | 10 | 0 | 2 | 1 | 36 |

### Sample Failures

- `gold-journal-exact-01` expected `{"status":"matched","quartile":"Q4","matchedTitle":"[Nippon koshu eisei zasshi] Japanese journal of public health","sourceYear":2019,"sourceYearFallback":false,"matchedSourceId":"22012","matchType":"title_exact"}` but saw `{"status":"missing","quartile":"N/A","matchedTitle":null,"sourceYear":null,"sourceYearFallback":false,"matchedSourceId":null,"matchType":null,"reason":null}`
- `gold-journal-exact-02` expected `{"status":"matched","quartile":"Q4","matchedTitle":"[Rinsho ketsueki] The Japanese journal of clinical hematology","sourceYear":2019,"sourceYearFallback":false,"matchedSourceId":"26063","matchType":"title_exact"}` but saw `{"status":"matched","quartile":"Q4","matchedTitle":"[Rinsho ketsueki] The Japanese journal of clinical hematology","sourceYear":2019,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`
- `gold-journal-exact-03` expected `{"status":"matched","quartile":"Q4","matchedTitle":"@GRH","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21101170611","matchType":"title_exact"}` but saw `{"status":"matched","quartile":"Q4","matchedTitle":"@GRH","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`
- `gold-journal-exact-04` expected `{"status":"matched","quartile":"Q2","matchedTitle":"1700-tal: Nordic Journal for Eighteenth-Century Studies","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21100832755","matchType":"title_exact"}` but saw `{"status":"matched","quartile":"Q2","matchedTitle":"1700-tal: Nordic Journal for Eighteenth-Century Studies","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`
- `gold-journal-exact-05` expected `{"status":"matched","quartile":"Q4","matchedTitle":"20 & 21: Revue d'Histoire","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21101194408","matchType":"title_exact"}` but saw `{"status":"matched","quartile":"Q4","matchedTitle":"20 & 21: Revue d'Histoire","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`
- `gold-journal-exact-06` expected `{"status":"matched","quartile":"Q3","matchedTitle":"21st Century Music","sourceYear":2014,"sourceYearFallback":false,"matchedSourceId":"18500162600","matchType":"title_exact"}` but saw `{"status":"matched","quartile":"Q3","matchedTitle":"21st Century Music","sourceYear":2014,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`
- `gold-journal-exact-07` expected `{"status":"matched","quartile":"Q1","matchedTitle":"2D Materials","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21100404576","matchType":"title_exact"}` but saw `{"status":"missing","quartile":"N/A","matchedTitle":null,"sourceYear":null,"sourceYearFallback":false,"matchedSourceId":null,"matchType":null,"reason":null}`
- `gold-journal-exact-08` expected `{"status":"matched","quartile":"Q1","matchedTitle":"3 Biotech","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21100447128","matchType":"title_exact_raw"}` but saw `{"status":"matched","quartile":"Q1","matchedTitle":"3 Biotech","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`
- `gold-journal-exact-09` expected `{"status":"matched","quartile":"Q2","matchedTitle":"3D Printing and Additive Manufacturing","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21100779062","matchType":"title_exact"}` but saw `{"status":"matched","quartile":"Q2","matchedTitle":"3D Printing and Additive Manufacturing","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_fuzzy","reason":null}`
- `gold-journal-exact-10` expected `{"status":"matched","quartile":"Q3","matchedTitle":"3D Printing in Medicine","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21100932761","matchType":"title_exact"}` but saw `{"status":"missing","quartile":"N/A","matchedTitle":null,"sourceYear":null,"sourceYearFallback":false,"matchedSourceId":null,"matchType":null,"reason":null}`

### pipeline_e2e

### Status Confusion

| Expected \ Actual | matched | missing | review | unranked |
| --- | --- | --- | --- | --- |
| matched | 46 | 4 | 0 | 0 |
| missing | 0 | 5 | 0 | 0 |
| review | 0 | 0 | 5 | 0 |
| unranked | 0 | 5 | 0 | 35 |

### Sample Failures

- `gold-pipeline-sjr-02` expected `{"system":"SJR","rank":"Q1","decisionStatus":"matched","matchedVenue":"2D Materials","sourceYear":2024,"sourceYearFallback":false}` but saw `{"system":"SJR","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":null,"sourceYearFallback":false,"confidence":1}`
- `gold-pipeline-sjr-04` expected `{"system":"SJR","rank":"Q3","decisionStatus":"matched","matchedVenue":"3D Printing in Medicine","sourceYear":2024,"sourceYearFallback":false}` but saw `{"system":"SJR","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":null,"sourceYearFallback":false,"confidence":1}`
- `gold-pipeline-sjr-05` expected `{"system":"SJR","rank":"Q3","decisionStatus":"matched","matchedVenue":"3D Research","sourceYear":2022,"sourceYearFallback":false}` but saw `{"system":"SJR","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":null,"sourceYearFallback":false,"confidence":1}`
- `gold-pipeline-sjr-06` expected `{"system":"SJR","rank":"Q1","decisionStatus":"matched","matchedVenue":"3L: Language, Linguistics, Literature","sourceYear":2024,"sourceYearFallback":false}` but saw `{"system":"SJR","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":null,"sourceYearFallback":false,"confidence":1}`
- `gold-pipeline-sensys-unranked-01` expected `{"system":"CORE","rank":"N/A","reason":"Unranked: merged","decisionStatus":"unranked"}` but saw `{"system":"CORE","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":2026,"sourceYearFallback":false,"confidence":1}`
- `gold-pipeline-sensys-unranked-02` expected `{"system":"CORE","rank":"N/A","reason":"Unranked: merged","decisionStatus":"unranked"}` but saw `{"system":"CORE","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":2026,"sourceYearFallback":false,"confidence":1}`
- `gold-pipeline-sensys-unranked-03` expected `{"system":"CORE","rank":"N/A","reason":"Unranked: merged","decisionStatus":"unranked"}` but saw `{"system":"CORE","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":2026,"sourceYearFallback":false,"confidence":1}`
- `gold-pipeline-sensys-unranked-04` expected `{"system":"CORE","rank":"N/A","reason":"Unranked: merged","decisionStatus":"unranked"}` but saw `{"system":"CORE","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":2026,"sourceYearFallback":false,"confidence":1}`
- `gold-pipeline-sensys-unranked-05` expected `{"system":"CORE","rank":"N/A","reason":"Unranked: merged","decisionStatus":"unranked"}` but saw `{"system":"CORE","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":2026,"sourceYearFallback":false,"confidence":1}`

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
| matched | 16 | 1 | 0 |
| missing | 0 | 40 | 0 |
| review | 0 | 0 | 1 |
| unranked | 0 | 2 | 0 |

### Sample Failures

- `gold-search-conference-10` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"ACM Conference on Embedded Networked Sensor Systems","currentStatusLabel":"Unranked: merged","latestRankedSnapshot":{"rank":"A*","sourceYear":2023,"matchedVenue":"ACM Conference on Embedded Networked Sensor Systems"},"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":{"rank":"A*","sourceYear":2023,"matchedVenue":"ACM Conference on Embedded Networked Sensor Systems"},"sourceYear":2026}`
- `gold-search-conference-11` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"ACM International Joint Conference on Pervasive and Ubiquitous Computing (PERVASIVE and UbiComp combined from 2013)","currentStatusLabel":"Journal published","latestRankedSnapshot":{"rank":"A*","sourceYear":2018,"matchedVenue":"ACM International Joint Conference on Pervasive and Ubiquitous Computing (PERVASIVE and UbiComp combined from 2013)"},"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":{"rank":"A*","sourceYear":2018,"matchedVenue":"ACM International Joint Conference on Pervasive and Ubiquitous Computing (PERVASIVE and UbiComp combined from 2013)"},"sourceYear":2026}`
- `gold-search-conference-12` expected `{"status":"matched","primaryLabel":"A*","matchedVenue":"Symposium on Networked Systems, Design and Implementation","currentStatusLabel":null,"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":{"rank":"B","sourceYear":2018,"matchedVenue":"Symposium on Networked Systems, Design and Implementation"},"sourceYear":2026}`

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
| conference_resolution | 900 | 747 | 83.0% | 98.3% | 100.0% | 15.3% | 0.4% | 0.09ms | 0.24ms |
| journal_resolution | 320 | 0 | 0.0% | 99.7% | 98.4% | 1.6% | 0.0% | 0.04ms | 0.04ms |
| pipeline_e2e | 240 | 210 | 87.5% | 100.0% | 94.4% | 54.6% | 2.1% | 0.79ms | 1.50ms |
| search_queries | 120 | 99 | 82.5% | 97.1% | 95.3% | 13.3% | 0.0% | 1.00ms | 5.49ms |

### conference_resolution

### Status Confusion

| Expected \ Actual | matched | missing | review |
| --- | --- | --- | --- |
| matched | 749 | 0 | 0 |
| review | 5 | 0 | 0 |
| unranked | 8 | 134 | 4 |

### Conference Rank Confusion

| Expected \ Actual | A | A* | B | C | N/A |
| --- | --- | --- | --- | --- | --- |
| A | 123 | 0 | 0 | 0 | 0 |
| A* | 0 | 84 | 0 | 0 | 0 |
| B | 0 | 0 | 251 | 0 | 0 |
| C | 0 | 0 | 0 | 291 | 0 |
| N/A | 2 | 0 | 5 | 6 | 138 |

### Sample Failures

- `shadow-conference-2026-infocomp` expected `{"status":"unranked","rank":"N/A","matchedVenue":"International Conference on Advanced Communications and Computation","rawRankLabel":"Unranked","matchType":"acronym_exact","sourceYear":2026,"confidence":1,"fullVenueTitle":"International Conference on Advanced Communications and Computation"}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"International Conference on Advanced Communications and Computation"}`
- `shadow-conference-2026-international-conference-on-advanced-communications-and-computation` expected `{"status":"unranked","rank":"N/A","matchedVenue":"International Conference on Advanced Communications and Computation","rawRankLabel":"Unranked","matchType":"alias_exact","sourceYear":2026,"confidence":1,"fullVenueTitle":"International Conference on Advanced Communications and Computation"}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"International Conference on Advanced Communications and Computation"}`
- `shadow-conference-2026-ant` expected `{"status":"unranked","rank":"N/A","matchedVenue":"International Conference on Ambient Systems, Networks and Technologies","rawRankLabel":"Unranked","matchType":"acronym_exact","sourceYear":2026,"confidence":1,"fullVenueTitle":"International Conference on Ambient Systems, Networks and Technologies"}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"International Conference on Ambient Systems, Networks and Technologies"}`
- `shadow-conference-2026-international-conference-on-ambient-systems-networks-and-technologies` expected `{"status":"unranked","rank":"N/A","matchedVenue":"International Conference on Ambient Systems, Networks and Technologies","rawRankLabel":"Unranked","matchType":"alias_exact","sourceYear":2026,"confidence":1,"fullVenueTitle":"International Conference on Ambient Systems, Networks and Technologies"}` but saw `{"status":"matched","rank":"C","matchedVenue":"International Conference on Web Information Systems and Technologies","rawRankLabel":"C","matchType":"fuzzy","sourceYear":2026,"confidence":0.8422838481211883,"fullVenueTitle":"International Conference on Ambient Systems, Networks and Technologies"}`
- `shadow-conference-2026-sensys` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM Conference on Embedded Networked Sensor Systems","rawRankLabel":"unranked: merged","matchType":"acronym_exact","sourceYear":2026,"confidence":1,"fullVenueTitle":"ACM Conference on Embedded Networked Sensor Systems"}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM Conference on Embedded Networked Sensor Systems"}`
- `shadow-conference-2026-acm-conference-on-embedded-networked-sensor-systems` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM Conference on Embedded Networked Sensor Systems","rawRankLabel":"unranked: merged","matchType":"alias_exact","sourceYear":2026,"confidence":1,"fullVenueTitle":"ACM Conference on Embedded Networked Sensor Systems"}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM Conference on Embedded Networked Sensor Systems"}`
- `shadow-conference-2026-sigite` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM Information Technology Education","rawRankLabel":null,"matchType":"acronym_exact","sourceYear":2026,"confidence":1,"fullVenueTitle":"ACM Information Technology Education"}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM Information Technology Education"}`
- `shadow-conference-2026-acm-information-technology-education` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM Information Technology Education","rawRankLabel":null,"matchType":"alias_exact","sourceYear":2026,"confidence":1,"fullVenueTitle":"ACM Information Technology Education"}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM Information Technology Education"}`
- `shadow-conference-2026-ace` expected `{"status":"unranked","rank":"N/A","matchedVenue":"Australasian Computing Education Conference (ACE)","rawRankLabel":null,"matchType":"acronym_disambiguated","sourceYear":2026,"confidence":0.5737872340425533,"fullVenueTitle":"ACM International Conference on Advances in Computer Entertainment (merged with DIMEA, Digital Interactive Media in Entertainment and Arts, in 2009)"}` but saw `{"status":"matched","rank":"C","matchedVenue":"ACM International Conference on Advances in Computer Entertainment (merged with DIMEA, Digital Interactive Media in Entertainment and Arts, in 2009)","rawRankLabel":"C","matchType":"acronym_exact","sourceYear":2026,"confidence":1,"fullVenueTitle":"ACM International Conference on Advances in Computer Entertainment (merged with DIMEA, Digital Interactive Media in Entertainment and Arts, in 2009)"}`
- `shadow-conference-2026-iss` expected `{"status":"unranked","rank":"N/A","matchedVenue":"ACM International Conference on Interactive Surfaces and Spaces (was International Workshop on Horizontal Interactive Human-Computer Systems: Tabletop)","rawRankLabel":"Journal Published","matchType":"acronym_exact","sourceYear":2026,"confidence":1,"fullVenueTitle":"ACM International Conference on Interactive Surfaces and Spaces (was International Workshop on Horizontal Interactive Human-Computer Systems: Tabletop)"}` but saw `{"status":"missing","rank":"N/A","matchedVenue":null,"rawRankLabel":null,"matchType":null,"sourceYear":2026,"confidence":null,"fullVenueTitle":"ACM International Conference on Interactive Surfaces and Spaces (was International Workshop on Horizontal Interactive Human-Computer Systems: Tabletop)"}`

### journal_resolution

### Status Confusion

| Expected \ Actual | matched | missing |
| --- | --- | --- |
| matched | 314 | 5 |
| review | 1 | 0 |

### Journal Quartile Confusion

| Expected \ Actual | N/A | Q1 | Q2 | Q3 | Q4 |
| --- | --- | --- | --- | --- | --- |
| N/A | 0 | 0 | 1 | 0 | 0 |
| Q1 | 2 | 107 | 0 | 0 | 0 |
| Q2 | 0 | 1 | 65 | 0 | 0 |
| Q3 | 3 | 0 | 0 | 63 | 0 |
| Q4 | 0 | 0 | 0 | 0 | 78 |

### Sample Failures

- `shadow-journal-001` expected `{"status":"matched","quartile":"Q4","matchedTitle":"@GRH","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21101170611","matchType":"title_exact","reason":null}` but saw `{"status":"matched","quartile":"Q4","matchedTitle":"@GRH","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`
- `shadow-journal-002` expected `{"status":"matched","quartile":"Q4","matchedTitle":"A + U-Architecture and Urbanism","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"16400154734","matchType":"title_exact","reason":null}` but saw `{"status":"matched","quartile":"Q4","matchedTitle":"A + U-Architecture and Urbanism","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`
- `shadow-journal-003` expected `{"status":"matched","quartile":"Q1","matchedTitle":"2D Materials","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21100404576","matchType":"title_exact","reason":null}` but saw `{"status":"missing","quartile":"N/A","matchedTitle":null,"sourceYear":null,"sourceYearFallback":false,"matchedSourceId":null,"matchType":null,"reason":null}`
- `shadow-journal-004` expected `{"status":"matched","quartile":"Q2","matchedTitle":"3D Printing and Additive Manufacturing","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21100779062","matchType":"title_exact","reason":null}` but saw `{"status":"matched","quartile":"Q2","matchedTitle":"3D Printing and Additive Manufacturing","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_fuzzy","reason":null}`
- `shadow-journal-005` expected `{"status":"matched","quartile":"Q3","matchedTitle":"3D Printing in Medicine","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21100932761","matchType":"title_exact","reason":null}` but saw `{"status":"missing","quartile":"N/A","matchedTitle":null,"sourceYear":null,"sourceYearFallback":false,"matchedSourceId":null,"matchType":null,"reason":null}`
- `shadow-journal-006` expected `{"status":"matched","quartile":"Q3","matchedTitle":"3D Research","sourceYear":2022,"sourceYearFallback":false,"matchedSourceId":"21100229836","matchType":"title_exact","reason":null}` but saw `{"status":"missing","quartile":"N/A","matchedTitle":null,"sourceYear":null,"sourceYearFallback":false,"matchedSourceId":null,"matchType":null,"reason":null}`
- `shadow-journal-007` expected `{"status":"matched","quartile":"Q1","matchedTitle":"3L: Language, Linguistics, Literature","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"19700200922","matchType":"title_exact","reason":null}` but saw `{"status":"missing","quartile":"N/A","matchedTitle":null,"sourceYear":null,"sourceYearFallback":false,"matchedSourceId":null,"matchType":null,"reason":null}`
- `shadow-journal-008` expected `{"status":"matched","quartile":"Q1","matchedTitle":"452ºF","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"21101005201","matchType":"title_exact","reason":null}` but saw `{"status":"matched","quartile":"Q1","matchedTitle":"452ºF","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`
- `shadow-journal-009` expected `{"status":"matched","quartile":"Q2","matchedTitle":"4OR","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"145295","matchType":"title_exact","reason":null}` but saw `{"status":"matched","quartile":"Q2","matchedTitle":"4OR","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`
- `shadow-journal-010` expected `{"status":"matched","quartile":"Q2","matchedTitle":"AAA - Arbeiten aus Anglistik und Amerikanistik","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":"5800207606","matchType":"title_exact","reason":null}` but saw `{"status":"matched","quartile":"Q2","matchedTitle":"AAA - Arbeiten aus Anglistik und Amerikanistik","sourceYear":2024,"sourceYearFallback":false,"matchedSourceId":null,"matchType":"title_exact","reason":null}`

### pipeline_e2e

### Status Confusion

| Expected \ Actual | matched | missing | review | unranked |
| --- | --- | --- | --- | --- |
| matched | 68 | 4 | 0 | 0 |
| missing | 0 | 117 | 0 | 0 |
| review | 0 | 0 | 5 | 0 |
| unranked | 0 | 5 | 0 | 41 |

### Sample Failures

- `shadow-gold-pipeline-sjr-01` expected `{"system":"SJR","rank":"Q4","reason":null,"decisionStatus":"matched","matchedVenue":"A + U-Architecture and Urbanism","matchedKey":"A + U-Architecture and Urbanism","matchedSourceId":"16400154734","sourceYear":2024,"sourceYearFallback":false,"confidence":1}` but saw `{"system":"SJR","rank":"Q4","reason":null,"decisionStatus":"matched","matchedVenue":"A + U-Architecture and Urbanism","matchedKey":"A + U-Architecture and Urbanism","matchedSourceId":null,"sourceYear":2024,"sourceYearFallback":false,"confidence":1}`
- `shadow-gold-pipeline-sjr-02` expected `{"system":"SJR","rank":"Q1","reason":null,"decisionStatus":"matched","matchedVenue":"2D Materials","matchedKey":"2D Materials","matchedSourceId":"21100404576","sourceYear":2024,"sourceYearFallback":false,"confidence":1}` but saw `{"system":"SJR","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":null,"sourceYearFallback":false,"confidence":1}`
- `shadow-gold-pipeline-sjr-03` expected `{"system":"SJR","rank":"Q2","reason":null,"decisionStatus":"matched","matchedVenue":"3D Printing and Additive Manufacturing","matchedKey":"3D Printing and Additive Manufacturing","matchedSourceId":"21100779062","sourceYear":2024,"sourceYearFallback":false,"confidence":1}` but saw `{"system":"SJR","rank":"Q2","reason":null,"decisionStatus":"matched","matchedVenue":"3D Printing and Additive Manufacturing","matchedKey":"3D Printing and Additive Manufacturing","matchedSourceId":null,"sourceYear":2024,"sourceYearFallback":false,"confidence":1}`
- `shadow-gold-pipeline-sjr-04` expected `{"system":"SJR","rank":"Q3","reason":null,"decisionStatus":"matched","matchedVenue":"3D Printing in Medicine","matchedKey":"3D Printing in Medicine","matchedSourceId":"21100932761","sourceYear":2024,"sourceYearFallback":false,"confidence":1}` but saw `{"system":"SJR","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":null,"sourceYearFallback":false,"confidence":1}`
- `shadow-gold-pipeline-sjr-05` expected `{"system":"SJR","rank":"Q3","reason":null,"decisionStatus":"matched","matchedVenue":"3D Research","matchedKey":"3D Research","matchedSourceId":"21100229836","sourceYear":2022,"sourceYearFallback":false,"confidence":1}` but saw `{"system":"SJR","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":null,"sourceYearFallback":false,"confidence":1}`
- `shadow-gold-pipeline-sjr-06` expected `{"system":"SJR","rank":"Q1","reason":null,"decisionStatus":"matched","matchedVenue":"3L: Language, Linguistics, Literature","matchedKey":"3L: Language, Linguistics, Literature","matchedSourceId":"19700200922","sourceYear":2024,"sourceYearFallback":false,"confidence":1}` but saw `{"system":"SJR","rank":"N/A","reason":null,"decisionStatus":"missing","matchedVenue":null,"matchedKey":null,"matchedSourceId":null,"sourceYear":null,"sourceYearFallback":false,"confidence":1}`
- `shadow-gold-pipeline-sjr-07` expected `{"system":"SJR","rank":"Q1","reason":null,"decisionStatus":"matched","matchedVenue":"452ºF","matchedKey":"452ºF","matchedSourceId":"21101005201","sourceYear":2024,"sourceYearFallback":false,"confidence":1}` but saw `{"system":"SJR","rank":"Q1","reason":null,"decisionStatus":"matched","matchedVenue":"452ºF","matchedKey":"452ºF","matchedSourceId":null,"sourceYear":2024,"sourceYearFallback":false,"confidence":1}`
- `shadow-gold-pipeline-sjr-08` expected `{"system":"SJR","rank":"Q2","reason":null,"decisionStatus":"matched","matchedVenue":"4OR","matchedKey":"4OR","matchedSourceId":"145295","sourceYear":2024,"sourceYearFallback":false,"confidence":1}` but saw `{"system":"SJR","rank":"Q2","reason":null,"decisionStatus":"matched","matchedVenue":"4OR","matchedKey":"4OR","matchedSourceId":null,"sourceYear":2024,"sourceYearFallback":false,"confidence":1}`
- `shadow-gold-pipeline-sjr-09` expected `{"system":"SJR","rank":"Q2","reason":null,"decisionStatus":"matched","matchedVenue":"AAA - Arbeiten aus Anglistik und Amerikanistik","matchedKey":"AAA - Arbeiten aus Anglistik und Amerikanistik","matchedSourceId":"5800207606","sourceYear":2024,"sourceYearFallback":false,"confidence":1}` but saw `{"system":"SJR","rank":"Q2","reason":null,"decisionStatus":"matched","matchedVenue":"AAA - Arbeiten aus Anglistik und Amerikanistik","matchedKey":"AAA - Arbeiten aus Anglistik und Amerikanistik","matchedSourceId":null,"sourceYear":2024,"sourceYearFallback":false,"confidence":1}`
- `shadow-gold-pipeline-sjr-10` expected `{"system":"SJR","rank":"Q1","reason":null,"decisionStatus":"matched","matchedVenue":"AAC: Augmentative and Alternative Communication","matchedKey":"AAC: Augmentative and Alternative Communication","matchedSourceId":"28033","sourceYear":2024,"sourceYearFallback":false,"confidence":1}` but saw `{"system":"SJR","rank":"Q1","reason":null,"decisionStatus":"matched","matchedVenue":"AAC: Augmentative and Alternative Communication","matchedKey":"AAC: Augmentative and Alternative Communication","matchedSourceId":null,"sourceYear":2024,"sourceYearFallback":false,"confidence":1}`

### search_queries

### Status Confusion

| Expected \ Actual | matched | missing |
| --- | --- | --- |
| matched | 101 | 5 |
| review | 1 | 0 |
| unranked | 2 | 11 |

### Sample Failures

- `shadow-search-conference-001` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"International Conference on Advanced Communications and Computation","currentStatusLabel":"Unranked","latestRankedSnapshot":null,"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":null,"sourceYear":2026}`
- `shadow-search-conference-002` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"International Conference on Advanced Communications and Computation","currentStatusLabel":"Unranked","latestRankedSnapshot":null,"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":{"rank":"C","sourceYear":2008,"matchedVenue":"International Conference on Advanced Computing and Communications"},"sourceYear":2026}`
- `shadow-search-conference-003` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"International Conference on Ambient Systems, Networks and Technologies","currentStatusLabel":"Unranked","latestRankedSnapshot":null,"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":null,"sourceYear":2026}`
- `shadow-search-conference-004` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"International Conference on Ambient Systems, Networks and Technologies","currentStatusLabel":"Unranked","latestRankedSnapshot":null,"sourceYear":2026}` but saw `{"status":"matched","primaryLabel":"C","matchedVenue":"International Conference on Web Information Systems and Technologies","currentStatusLabel":"C","latestRankedSnapshot":{"rank":"C","sourceYear":2023,"matchedVenue":"International Conference on Web Information Systems and Technologies"},"sourceYear":2026}`
- `shadow-search-conference-019` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"ACM Conference on Embedded Networked Sensor Systems","currentStatusLabel":"Unranked: merged","latestRankedSnapshot":{"rank":"A*","sourceYear":2023,"matchedVenue":"ACM Conference on Embedded Networked Sensor Systems"},"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":{"rank":"A*","sourceYear":2023,"matchedVenue":"ACM Conference on Embedded Networked Sensor Systems"},"sourceYear":2026}`
- `shadow-search-conference-020` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"ACM Conference on Embedded Networked Sensor Systems","currentStatusLabel":"Unranked: merged","latestRankedSnapshot":{"rank":"A*","sourceYear":2023,"matchedVenue":"ACM Conference on Embedded Networked Sensor Systems"},"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":{"rank":"A*","sourceYear":2023,"matchedVenue":"ACM Conference on Embedded Networked Sensor Systems"},"sourceYear":2026}`
- `shadow-search-conference-027` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"ACM Information Technology Education","currentStatusLabel":null,"latestRankedSnapshot":{"rank":"C","sourceYear":2018,"matchedVenue":"ACM Information Technology Education"},"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":{"rank":"C","sourceYear":2018,"matchedVenue":"ACM Information Technology Education"},"sourceYear":2026}`
- `shadow-search-conference-028` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"ACM Information Technology Education","currentStatusLabel":null,"latestRankedSnapshot":{"rank":"C","sourceYear":2018,"matchedVenue":"ACM Information Technology Education"},"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":{"rank":"C","sourceYear":2018,"matchedVenue":"ACM Information Technology Education"},"sourceYear":2026}`
- `shadow-search-conference-031` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"Australasian Computing Education Conference (ACE)","currentStatusLabel":null,"latestRankedSnapshot":{"rank":"B","sourceYear":2010,"matchedVenue":"Australasian Computing Education Conference (ACE)"},"sourceYear":2026}` but saw `{"status":"matched","primaryLabel":"C","matchedVenue":"ACM International Conference on Advances in Computer Entertainment (merged with DIMEA, Digital Interactive Media in Entertainment and Arts, in 2009)","currentStatusLabel":"C","latestRankedSnapshot":{"rank":"C","sourceYear":2023,"matchedVenue":"ACM International Conference on Advances in Computer Entertainment (merged with DIMEA, Digital Interactive Media in Entertainment and Arts, in 2009)"},"sourceYear":2026}`
- `shadow-search-conference-041` expected `{"status":"unranked","primaryLabel":"Unranked","matchedVenue":"ACM International Conference on Interactive Surfaces and Spaces (was International Workshop on Horizontal Interactive Human-Computer Systems: Tabletop)","currentStatusLabel":"Journal Published","latestRankedSnapshot":{"rank":"A","sourceYear":2020,"matchedVenue":"ACM International Conference on Interactive Surfaces and Spaces (was International Workshop on Horizontal Interactive Human-Computer Systems: Tabletop)"},"sourceYear":2026}` but saw `{"status":"missing","primaryLabel":"Not found","matchedVenue":null,"currentStatusLabel":null,"latestRankedSnapshot":{"rank":"A","sourceYear":2020,"matchedVenue":"ACM International Conference on Interactive Surfaces and Spaces (was International Workshop on Horizontal Interactive Human-Computer Systems: Tabletop)"},"sourceYear":2026}`
