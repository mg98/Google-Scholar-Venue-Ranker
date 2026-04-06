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

  const setStatus = (message) => {
    if (statusEl) {
      statusEl.textContent = message;
    }
  };

  const settings = await api.loadSettings();
  controls.autoRun.checked = settings.autoRun;
  controls.compactMode.checked = settings.compactMode;
  controls.showUnranked.checked = settings.showUnranked;
  controls.defaultHighlightMode.value = settings.defaultHighlightMode;

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
