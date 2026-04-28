"use strict";

(async function initOptions() {
  const api = window.GSVRSettings;
  const form = document.getElementById("optionsForm");
  const statusEl = document.getElementById("optionsStatus");
  const controls = {
    autoRun: document.getElementById("autoRun"),
    compactMode: document.getElementById("compactMode"),
    showUnranked: document.getElementById("showUnranked"),
    showDebugDetails: document.getElementById("showDebugDetails"),
    defaultHighlightMode: document.getElementById("defaultHighlightMode")
  };
  const freshnessSummary = document.getElementById("freshnessSummary");

  const setStatus = (message) => {
    if (statusEl) {
      statusEl.textContent = message;
    }
  };

  async function syncForm() {
    const settings = await api.loadSettings();
    const packs = await api.loadRankingPacks();
    const freshness = await api.loadFeatureState("dataFreshnessState");
    controls.autoRun.checked = settings.autoRun;
    controls.compactMode.checked = settings.compactMode;
    controls.showUnranked.checked = settings.showUnranked;
    controls.showDebugDetails.checked = settings.showDebugDetails;
    controls.defaultHighlightMode.value = settings.defaultHighlightMode;
    if (freshnessSummary) {
      const version = freshness?.lastSeenVersion || "unknown";
      const refreshed = freshness?.lastDataRefreshLabel || "No profile freshness recorded yet";
      freshnessSummary.textContent = `Last seen version: ${version}. Last local data label: ${refreshed}.`;
    }
  }

  function buildSelectedPacks() {
    return api.DEFAULT_RANKING_PACKS || ["core", "sjr"];
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await api.replaceSettings({
      autoRun: controls.autoRun.checked,
      compactMode: controls.compactMode.checked,
      showUnranked: controls.showUnranked.checked,
      showDebugDetails: controls.showDebugDetails.checked,
      defaultHighlightMode: controls.defaultHighlightMode.value
    });
    await api.saveRankingPacks(buildSelectedPacks());
    setStatus("Settings saved. Reload open Scholar tabs to apply everything immediately.");
  });

  document.getElementById("resetButton")?.addEventListener("click", async () => {
    await api.resetSettings();
    await api.saveRankingPacks(api.DEFAULT_RANKING_PACKS);
    await syncForm();
    setStatus("Defaults restored.");
  });

  try {
    await syncForm();
  } catch (error) {
    console.error("GSVR options failed to load.", error);
    setStatus("Settings could not be loaded. Try reloading this page.");
  }
})();
