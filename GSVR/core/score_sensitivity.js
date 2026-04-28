(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./score_config.js"), require("./score_model.js"));
  } else {
    root.GSVRScoreSensitivity = factory(root.GSVRScoreConfig, root.GSVRScoreModel);
  }
})(typeof self !== "undefined" ? self : this, function (scoreConfig, scoreModel) {
  "use strict";

  function createVariantConfig(baseConfig, variantName) {
    const config = scoreConfig.createScoreConfig(baseConfig);
    switch (variantName) {
      case "core_sjr_scheme_a":
        return {
          ...config,
          venueValues: {
            CORE: { "A*": 1, A: 0.8, B: 0.55, C: 0.3 },
            SJR: { Q1: 0.8, Q2: 0.55, Q3: 0.3, Q4: 0.1 },
          },
        };
      case "core_sjr_scheme_b":
        return {
          ...config,
          venueValues: {
            CORE: { "A*": 1, A: 0.7, B: 0.45, C: 0.2 },
            SJR: { Q1: 0.7, Q2: 0.45, Q3: 0.2, Q4: 0.05 },
          },
        };
      case "include_workshops":
      case "include_workshop":
        return {
          ...config,
          eligiblePublicationTypes: [...new Set([...(config.eligiblePublicationTypes || []), "workshop"])],
        };
      case "include_short_papers":
      case "include_short":
        return {
          ...config,
          eligiblePublicationTypes: [...new Set([...(config.eligiblePublicationTypes || []), "short_paper"])],
        };
      case "core_only":
        return { ...config, sourceFilter: "CORE" };
      case "sjr_only":
        return { ...config, sourceFilter: "SJR" };
      case "recent_5_year_score":
        return { ...config, recentYears: 5 };
      default:
        return config;
    }
  }

  function getScoreValue(score) {
    return Number(score?.scores?.gsvrScore ?? score?.gsvrScore ?? 0);
  }

  function summarizeStability(scores) {
    const values = scores.map((item) => getScoreValue(item?.score));
    if (!values.length) {
      return { min: 0, max: 0, mean: 0, sd: 0 };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const variance = values.reduce((total, value) => total + Math.pow(value - mean, 2), 0) / values.length;
    return { min, max, mean, sd: Math.sqrt(variance) };
  }

  function changedItemCount(primary, variant) {
    const primaryItems = Array.isArray(primary?.publications) ? primary.publications : [];
    const variantItems = Array.isArray(variant?.publications) ? variant.publications : [];
    const length = Math.max(primaryItems.length, variantItems.length);
    let changed = 0;
    for (let index = 0; index < length; index += 1) {
      const left = Number(primaryItems[index]?.score?.contribution || 0);
      const right = Number(variantItems[index]?.score?.contribution || 0);
      if (Math.abs(left - right) > 1e-9) {
        changed += 1;
      }
    }
    return changed;
  }

  function runSensitivity(publicationDecisions, baseConfig = scoreConfig.DEFAULT_SCORE_CONFIG, variantConfigs = null) {
    const config = scoreConfig.createScoreConfig(baseConfig);
    const primary = scoreModel.computeProfileScore(publicationDecisions, config);
    const variantNames = Array.isArray(variantConfigs) && variantConfigs.length
      ? variantConfigs.map((variant) => typeof variant === "string" ? variant : variant?.name).filter(Boolean)
      : config.sensitivityVariants;
    const variants = variantNames.map((name) => {
      const variantConfig = createVariantConfig(config, name);
      const score = scoreModel.computeProfileScore(publicationDecisions, variantConfig);
      const delta = getScoreValue(score) - getScoreValue(primary);
      return {
        name,
        score,
        delta,
        changedItems: changedItemCount(primary, score),
        explanation: `Variant ${name} changed the GSVR Score by ${delta.toFixed(4)}.`,
      };
    });
    return {
      primary,
      variants,
      stability: summarizeStability([{ name: "primary", score: primary }, ...variants]),
    };
  }

  return {
    createVariantConfig,
    runSensitivity,
  };
});
