(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GSVRScoreConfig = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCORE_MODEL_VERSION = "gsvr-fractional-venue-v1";

  const VENUE_VALUES = Object.freeze({
    CORE: Object.freeze({
      "A*": 1.00,
      A: 0.75,
      B: 0.50,
      C: 0.25,
    }),
    SJR: Object.freeze({
      Q1: 0.75,
      Q2: 0.50,
      Q3: 0.25,
      Q4: 0.10,
    }),
  });

  const ELIGIBLE_PUBLICATION_TYPES = Object.freeze([
    "full_conference",
    "full_journal",
  ]);

  const DEFAULT_SENSITIVITY_VARIANTS = Object.freeze([
    "core_sjr_scheme_a",
    "core_sjr_scheme_b",
    "include_workshops",
    "include_short_papers",
    "core_only",
    "sjr_only",
    "recent_5_year_score",
  ]);

  const DEFAULT_SCORE_CONFIG = Object.freeze({
    schemaVersion: "gsvr-score-config-v2",
    scoreModelVersion: SCORE_MODEL_VERSION,
    formula: "sum(venueValue / authorCount)",
    authorship: "fractional",
    authorshipModel: "fractional_counting",
    fractionalCountingOnly: true,
    eligiblePublicationTypes: ELIGIBLE_PUBLICATION_TYPES,
    venueValues: VENUE_VALUES,
    sensitivityVariants: DEFAULT_SENSITIVITY_VARIANTS,
  });

  function clonePlain(value) {
    if (Array.isArray(value)) {
      return value.map(clonePlain);
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = clonePlain(item);
      }
      return out;
    }
    return value;
  }

  function normalizeSource(source) {
    return String(source || "").trim().toUpperCase();
  }

  function normalizeRank(rank) {
    return String(rank || "").trim().toUpperCase();
  }

  function normalizeEligibleTypes(types) {
    const values = Array.isArray(types) ? types : ELIGIBLE_PUBLICATION_TYPES;
    return values
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }

  function mergeVenueValues(baseValues, overrideValues) {
    const base = clonePlain(baseValues || VENUE_VALUES);
    const overrides = overrideValues && typeof overrideValues === "object" ? overrideValues : {};
    return {
      CORE: { ...(base.CORE || {}), ...(overrides.CORE || {}) },
      SJR: { ...(base.SJR || {}), ...(overrides.SJR || {}) },
    };
  }

  function createScoreConfig(overrides = {}) {
    const base = clonePlain(DEFAULT_SCORE_CONFIG);
    const next = overrides && typeof overrides === "object" ? overrides : {};
    const venueValues = mergeVenueValues(base.venueValues, next.venueValues);
    return {
      ...base,
      ...next,
      scoreModelVersion: SCORE_MODEL_VERSION,
      formula: "sum(venueValue / authorCount)",
      authorship: "fractional",
      authorshipModel: "fractional_counting",
      fractionalCountingOnly: true,
      venueValues,
      eligiblePublicationTypes: normalizeEligibleTypes(next.eligiblePublicationTypes || base.eligiblePublicationTypes),
      sensitivityVariants: Array.isArray(next.sensitivityVariants)
        ? next.sensitivityVariants.slice()
        : base.sensitivityVariants,
    };
  }

  function getVenueValue(source, rank, config = DEFAULT_SCORE_CONFIG) {
    const normalizedSource = normalizeSource(source);
    const normalizedRank = normalizeRank(rank);
    const value = Number(config?.venueValues?.[normalizedSource]?.[normalizedRank]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function getRankScale(source, rank, config = DEFAULT_SCORE_CONFIG) {
    const value = getVenueValue(source, rank, config);
    return value == null ? null : { mean: value, sd: 0 };
  }

  function getScoringPolicy(config = DEFAULT_SCORE_CONFIG) {
    const active = createScoreConfig(config);
    return {
      formula: active.formula,
      authorship: "fractional",
      eligiblePublicationTypes: active.eligiblePublicationTypes.slice(),
      venueValues: clonePlain(active.venueValues),
      fractionalCountingOnly: true,
    };
  }

  return {
    SCORE_MODEL_VERSION,
    VENUE_VALUES,
    ELIGIBLE_PUBLICATION_TYPES,
    DEFAULT_SENSITIVITY_VARIANTS,
    DEFAULT_SCORE_CONFIG,
    createScoreConfig,
    getVenueValue,
    getRankScale,
    getScoringPolicy,
  };
});
