(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./score_config.js"));
  } else {
    root.GSVRPublicationType = factory(root.GSVRScoreConfig);
  }
})(typeof self !== "undefined" ? self : this, function (scoreConfig) {
  "use strict";

  const DEFAULT_SCORE_CONFIG = scoreConfig.DEFAULT_SCORE_CONFIG;

  function normalizeText(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function evidenceTokens(publication) {
    return Array.isArray(publication?.decisionEvidence)
      ? publication.decisionEvidence.map((value) => String(value || "").trim()).filter(Boolean)
      : Array.isArray(publication?.match?.evidence)
        ? publication.match.evidence.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
  }

  function hasPreprintSignal({ title, venue, dblpKey }) {
    const key = normalizeText(dblpKey);
    const venueText = normalizeText(venue);
    const titleText = normalizeText(title);
    if (key.startsWith("journals/corr") || /\b(arxiv|corr|preprint)\b/i.test(venueText)) {
      return true;
    }
    return /\b(arxiv|corr|preprint)\b/i.test(titleText);
  }

  function detectPublicationType(publication) {
    const explicit = String(publication?.classification?.publicationType || publication?.publicationType || "").trim();
    if (explicit) {
      return { publicationType: explicit, signals: ["explicit_type"] };
    }

    const signals = [];
    const tokens = evidenceTokens(publication);
    const reason = normalizeText(publication?.reason || publication?.exclusionReason || "");
    const title = normalizeText(publication?.paperTitle || publication?.title || publication?.scholar?.title || "");
    const venue = normalizeText(publication?.venue || publication?.dblpVenue || publication?.ranking?.matchedVenue || publication?.dblp?.venue || publication?.dblp?.venueFull || "");
    const dblpKey = normalizeText(publication?.dblpKey || publication?.dblp?.key || "");
    const dblpType = normalizeText(publication?.dblpType || publication?.dblp?.type || "");
    const source = String(publication?.system || publication?.ranking?.source || publication?.source || "").trim().toUpperCase();

    const hasToken = (token) => tokens.includes(token);
    const hasAny = (...values) => values.some((value) => reason.includes(value) || venue.includes(value));

    if (hasToken("extended_abstract") || hasAny("extended abstract")) {
      signals.push("extended_abstract");
      return { publicationType: "extended_abstract", signals };
    }
    if (
      hasToken("demo_poster")
      || /\b(demo|poster|companion|adjunct)\b/.test(reason)
      || /\b(demo|poster|companion|adjunct|doctoral consortium|doctoral symposium|ph\.d\. forum|phd forum)\b/.test(venue)
      || /^(demo|demonstration|poster|doctoral consortium|doctoral symposium|ph\.d\. forum|phd forum)\s*:/.test(title)
    ) {
      signals.push("demo_poster");
      return { publicationType: title.includes("poster") || venue.includes("poster") ? "poster" : "demo", signals };
    }
    if (hasToken("short_by_pages") || reason.includes("short-paper") || reason.includes("short paper")) {
      signals.push("short_by_pages");
      return { publicationType: "short_paper", signals };
    }
    if (hasToken("workshop") || /\bworkshop\b/.test(reason) || /\bworkshop\b/.test(venue) || /\b\w+\s*@\s*\w+\b/.test(venue)) {
      signals.push("workshop");
      return { publicationType: "workshop", signals };
    }
    if (hasPreprintSignal({ title, venue, dblpKey })) {
      signals.push("preprint");
      return { publicationType: "preprint", signals };
    }
    if (dblpType === "incollection" || dblpKey.startsWith("books/") || hasAny("book chapter")) {
      signals.push("book_chapter");
      return { publicationType: "book_chapter", signals };
    }
    if (source === "SJR" || dblpType === "article" || dblpKey.startsWith("journals/")) {
      signals.push("journal_source");
      return { publicationType: "full_journal", signals };
    }
    if (source === "CORE" || dblpType === "inproceedings" || dblpKey.startsWith("conf/")) {
      signals.push("conference_source");
      return { publicationType: "full_conference", signals };
    }

    signals.push("unknown_type");
    return { publicationType: "unknown", signals };
  }

  function isEligiblePublicationType(publicationType, config = DEFAULT_SCORE_CONFIG) {
    const activeConfig = scoreConfig.createScoreConfig(config);
    return activeConfig.eligiblePublicationTypes.includes(String(publicationType || "").trim());
  }

  function classifyPublicationType(publication, config = DEFAULT_SCORE_CONFIG) {
    const detected = detectPublicationType(publication);
    const publicationType = detected.publicationType;
    const scoreEligibleByType = isEligiblePublicationType(publicationType, config);
    return {
      publicationType,
      scoreEligibleByType,
      eligible: scoreEligibleByType,
      typeExclusionReason: scoreEligibleByType ? null : publicationType,
      exclusionReason: scoreEligibleByType ? null : publicationType,
      signals: detected.signals,
    };
  }

  return {
    detectPublicationType,
    isEligiblePublicationType,
    classifyPublicationType,
  };
});
