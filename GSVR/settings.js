(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GSVRSettings = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SETTINGS_KEY = "gsvr_settings_v1";
  const FEATURE_STORAGE_KEYS = Object.freeze({
    reportDraft: "gsvr_report_draft_v1",
    enabledRankingPacks: "gsvr_enabled_ranking_packs_v1",
  });
  const AVAILABLE_RANKING_PACKS = Object.freeze(["core", "sjr", "ccf", "abdc", "era"]);
  const DEFAULT_RANKING_PACKS = Object.freeze(["core", "sjr"]);
  const DEFAULT_SETTINGS = Object.freeze({
    autoRun: true,
    compactMode: false,
    showUnranked: true,
    defaultHighlightMode: "none",
    showDebugDetails: true
  });
  const DEFAULT_FEATURE_STATE = Object.freeze({
    reportDraft: Object.freeze({
      createdAt: null,
      payload: null,
    }),
    enabledRankingPacks: DEFAULT_RANKING_PACKS,
  });
  const HIGHLIGHT_MODES = Object.freeze(["none", "ranked-only", "needs-review"]);

  function normalizeSettings(raw) {
    const settings = raw && typeof raw === "object" ? raw : {};
    const next = {
      autoRun: settings.autoRun !== false,
      compactMode: settings.compactMode === true,
      showUnranked: settings.showUnranked !== false,
      defaultHighlightMode: HIGHLIGHT_MODES.includes(settings.defaultHighlightMode)
        ? settings.defaultHighlightMode
        : DEFAULT_SETTINGS.defaultHighlightMode,
      showDebugDetails: settings.showDebugDetails !== false
    };
    return next;
  }

  function cloneDefaultFeatureValue(name) {
    const value = DEFAULT_FEATURE_STATE[name];
    if (Array.isArray(value)) {
      return value.slice();
    }
    if (value && typeof value === "object") {
      return { ...value };
    }
    return value;
  }

  function normalizeRankingPacks(raw) {
    const list = Array.isArray(raw) ? raw : [raw];
    const extras = [];
    for (const value of list) {
      const normalized = String(value || "").trim().toLowerCase();
      if (!AVAILABLE_RANKING_PACKS.includes(normalized)) {
        continue;
      }
      if (normalized === "core" || normalized === "sjr") {
        continue;
      }
      if (!extras.includes(normalized)) {
        extras.push(normalized);
      }
    }
    return ["core", "sjr", ...extras];
  }

  function normalizeFeatureState(name, raw) {
    if (name === "enabledRankingPacks") {
      return normalizeRankingPacks(raw);
    }

    const fallback = cloneDefaultFeatureValue(name);
    if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) {
      return raw == null ? fallback : raw;
    }

    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return { ...fallback, ...value };
  }

  async function getArea() {
    return chrome?.storage?.local;
  }

  async function loadFeatureState(name) {
    const storageKey = FEATURE_STORAGE_KEYS[name];
    if (!storageKey) {
      throw new Error(`Unknown GSVR feature storage key: ${name}`);
    }
    const area = await getArea();
    const fallback = cloneDefaultFeatureValue(name);
    if (!area?.get) {
      return normalizeFeatureState(name, fallback);
    }
    try {
      const result = await area.get(storageKey);
      return normalizeFeatureState(name, result?.[storageKey]);
    } catch {
      return normalizeFeatureState(name, fallback);
    }
  }

  async function saveFeatureState(name, value) {
    const storageKey = FEATURE_STORAGE_KEYS[name];
    if (!storageKey) {
      throw new Error(`Unknown GSVR feature storage key: ${name}`);
    }
    const area = await getArea();
    const normalized = normalizeFeatureState(name, value);
    if (!area?.set) {
      return normalized;
    }
    await area.set({ [storageKey]: normalized });
    return normalized;
  }

  async function removeFeatureState(name) {
    const storageKey = FEATURE_STORAGE_KEYS[name];
    if (!storageKey) {
      throw new Error(`Unknown GSVR feature storage key: ${name}`);
    }
    const area = await getArea();
    if (!area?.remove) {
      return cloneDefaultFeatureValue(name);
    }
    await area.remove(storageKey);
    return cloneDefaultFeatureValue(name);
  }

  async function loadRankingPacks() {
    return loadFeatureState("enabledRankingPacks");
  }

  async function saveRankingPacks(value) {
    return saveFeatureState("enabledRankingPacks", value);
  }

  async function loadSettings() {
    const area = await getArea();
    if (!area?.get) {
      return { ...DEFAULT_SETTINGS };
    }
    try {
      const result = await area.get(SETTINGS_KEY);
      return normalizeSettings(result?.[SETTINGS_KEY]);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function replaceSettings(value) {
    const area = await getArea();
    const normalized = normalizeSettings(value);
    if (!area?.set) {
      return normalized;
    }
    await area.set({ [SETTINGS_KEY]: normalized });
    return normalized;
  }

  async function saveSettings(partial) {
    const current = await loadSettings();
    return replaceSettings({ ...current, ...(partial || {}) });
  }

  async function resetSettings() {
    return replaceSettings(DEFAULT_SETTINGS);
  }

  return {
    SETTINGS_KEY,
    FEATURE_STORAGE_KEYS,
    AVAILABLE_RANKING_PACKS,
    DEFAULT_RANKING_PACKS,
    DEFAULT_SETTINGS,
    DEFAULT_FEATURE_STATE,
    HIGHLIGHT_MODES,
    normalizeSettings,
    normalizeRankingPacks,
    normalizeFeatureState,
    loadSettings,
    replaceSettings,
    saveSettings,
    resetSettings
    ,
    loadFeatureState,
    saveFeatureState,
    removeFeatureState,
    loadRankingPacks,
    saveRankingPacks
  };
});
