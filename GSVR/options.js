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

  const setStatus = (message) => {
    if (statusEl) {
      statusEl.textContent = message;
    }
  };

  async function syncForm() {
    const settings = await api.loadSettings();
    controls.autoRun.checked = settings.autoRun;
    controls.compactMode.checked = settings.compactMode;
    controls.showUnranked.checked = settings.showUnranked;
    controls.showDebugDetails.checked = settings.showDebugDetails;
    controls.defaultHighlightMode.value = settings.defaultHighlightMode;
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
    setStatus("Settings saved. Reload open Scholar tabs to apply everything immediately.");
  });

  document.getElementById("resetButton")?.addEventListener("click", async () => {
    await api.resetSettings();
    await syncForm();
    setStatus("Defaults restored.");
  });

  await syncForm();
})();
