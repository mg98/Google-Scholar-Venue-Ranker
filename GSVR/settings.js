(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GSVRSettings = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SETTINGS_KEY = "gsvr_settings_v1";
  const DEFAULT_SETTINGS = Object.freeze({
    autoRun: true,
    compactMode: false,
    showUnranked: true,
    defaultHighlightMode: "none",
    showDebugDetails: true
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

  async function getArea() {
    return chrome?.storage?.local;
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
    DEFAULT_SETTINGS,
    HIGHLIGHT_MODES,
    normalizeSettings,
    loadSettings,
    replaceSettings,
    saveSettings,
    resetSettings
  };
});
