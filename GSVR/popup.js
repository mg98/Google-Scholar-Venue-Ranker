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
  const versionBadgeEl = document.getElementById("versionBadge");
  const tabStateEl = document.getElementById("tabState");
  const rescanButton = document.getElementById("rescanProfile");

  const setStatus = (message) => {
    if (statusEl) {
      statusEl.textContent = message;
    }
  };

  if (versionBadgeEl && chrome?.runtime?.getManifest) {
    versionBadgeEl.textContent = `v${chrome.runtime.getManifest().version}`;
  }

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

  // ----- live state of the active tab -----

  async function getActiveScholarTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https:\/\/scholar\.google\./.test(tab.url || "")) {
        return null;
      }
      return tab;
    } catch {
      return null;
    }
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          // Reading lastError prevents "Unchecked runtime.lastError" noise when
          // the content script is not present (e.g. tab opened pre-install).
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function describeTabState(state) {
    if (!state?.ok) {
      return "Open a Scholar profile page to see its scan state here.";
    }
    if (state.surfaceMode !== "profile") {
      return "This Scholar page is not an author profile; GSVR runs on profile pages.";
    }
    const who = state.authorName ? `${state.authorName}: ` : "";
    if (state.isScanning) {
      return `${who}scan in progress…`;
    }
    if (!state.hasResults) {
      return `${who}not scanned yet. Use Rescan to start.`;
    }
    const scoreText = typeof state.gsvrScore === "number" ? ` · GSVR ${state.gsvrScore.toFixed(2)}` : "";
    const whenText = state.updatedAt
      ? ` · updated ${new Date(state.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : "";
    return `${who}${state.publicationCount} publications ranked${scoreText}${whenText}`;
  }

  async function refreshTabState() {
    const tab = await getActiveScholarTab();
    if (!tab) {
      if (tabStateEl) tabStateEl.textContent = "Open a Google Scholar profile to see live status.";
      if (rescanButton) rescanButton.disabled = true;
      return;
    }
    const state = await sendTabMessage(tab.id, { type: "GSVR_POPUP_STATUS" });
    if (tabStateEl) tabStateEl.textContent = describeTabState(state);
    if (rescanButton) {
      rescanButton.disabled = !(state?.ok && state.surfaceMode === "profile" && !state.isScanning);
    }
  }

  rescanButton?.addEventListener("click", async () => {
    const tab = await getActiveScholarTab();
    if (!tab) return;
    rescanButton.disabled = true;
    const response = await sendTabMessage(tab.id, { type: "GSVR_POPUP_RESCAN" });
    if (response?.ok) {
      setStatus("Rescan started. The sidebar updates as results come in.");
    } else if (response?.reason === "busy") {
      setStatus("A scan is already running on this profile.");
    } else {
      setStatus("Could not start a rescan on this tab.");
    }
    window.setTimeout(refreshTabState, 600);
  });

  await refreshTabState();

  // ----- settings persistence -----

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
