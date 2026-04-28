"use strict";

(async function initPopup() {
  const api = window.GSVRSettings;
  const statusEl = document.getElementById("popupStatus");
  const controls = {
    autoRun: document.getElementById("autoRun"),
    compactMode: document.getElementById("compactMode"),
    showUnranked: document.getElementById("showUnranked"),
    defaultHighlightMode: document.getElementById("defaultHighlightMode")
  };
  const activePacksEl = document.getElementById("activePacks");
  const freshnessBadgeEl = document.getElementById("freshnessBadge");

  const setStatus = (message) => {
    if (statusEl) {
      statusEl.textContent = message;
    }
  };

  try {
    const settings = await api.loadSettings();
    const rankingPacks = await api.loadRankingPacks();
    const freshness = await api.loadFeatureState("dataFreshnessState");
    controls.autoRun.checked = settings.autoRun;
    controls.compactMode.checked = settings.compactMode;
    controls.showUnranked.checked = settings.showUnranked;
    controls.defaultHighlightMode.value = settings.defaultHighlightMode;
    if (activePacksEl) {
      activePacksEl.textContent = `Ranking packs: ${rankingPacks.map((value) => value.toUpperCase()).join(", ")}`;
    }
    if (freshnessBadgeEl) {
      freshnessBadgeEl.textContent = freshness?.lastDataRefreshLabel
        ? `Freshness: ${freshness.lastDataRefreshLabel}`
        : "Freshness metadata appears after a Scholar run.";
    }
  } catch (error) {
    console.error("GSVR popup failed to load.", error);
    setStatus("Settings could not be loaded. Open Options or reload the extension.");
  }

  async function persist() {
    await api.saveSettings({
      autoRun: controls.autoRun.checked,
      compactMode: controls.compactMode.checked,
      showUnranked: controls.showUnranked.checked,
      defaultHighlightMode: controls.defaultHighlightMode.value
    });
    setStatus("Settings saved. Reload Scholar if the page is already open.");
  }

  for (const control of Object.values(controls)) {
    control.addEventListener("change", persist);
  }

  document.getElementById("openOptions")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById("openScholar")?.addEventListener("click", async () => {
    await chrome.tabs.create({ url: "https://scholar.google.com/" });
  });
})();
