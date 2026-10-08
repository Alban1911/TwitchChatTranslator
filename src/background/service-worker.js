// Service worker: DeepL requests, toolbar badge, settings migration.
importScripts("../shared/settings.js", "deepl.js");

const { settings, MSG } = TCT;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== MSG.DEEPL_TRANSLATE) return false;
  TCT.deepl.translate(String(message.text ?? ""), String(message.targetLang ?? "")).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: TCT.deepl.toPlainError(error) })
  );
  return true; // Responds asynchronously.
});

// ---- Badge ------------------------------------------------------------------

const BADGES = {
  off: { text: "×", color: "#777777", title: "Twitch Chat Translator: Off" },
  on: { text: "✓", color: "#0F7B0F", title: "Twitch Chat Translator: On" },
  error: { text: "!", color: "#B3261E", title: "Twitch Chat Translator: DeepL error" },
};

async function refreshBadge() {
  const [s, { deeplStatus }] = await Promise.all([
    settings.load({ secrets: false }),
    chrome.storage.session.get("deeplStatus"),
  ]);
  const usesDeepl = s.engine === "deepl" || s.deeplFallback;
  let badge = s.enabled ? BADGES.on : BADGES.off;
  if (s.enabled && usesDeepl && deeplStatus) {
    badge = { ...BADGES.error, title: `Twitch Chat Translator: ${deeplStatus.message}` };
  }
  await Promise.all([
    chrome.action.setBadgeText({ text: badge.text }),
    chrome.action.setBadgeBackgroundColor({ color: badge.color }),
    chrome.action.setBadgeTextColor?.({ color: "#FFFFFF" }),
    chrome.action.setTitle({ title: badge.title }),
  ]);
}

function refreshBadgeSafely() {
  refreshBadge().catch((error) => console.warn("[TCT] badge:", error));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.deeplAuthKey) {
    // A new key deserves a fresh start.
    chrome.storage.session.remove("deeplStatus").catch(() => {});
    return;
  }
  if ((area === "sync" && (changes.enabled || changes.engine || changes.deeplFallback)) || (area === "session" && changes.deeplStatus)) {
    refreshBadgeSafely();
  }
});

// ---- Install / update -------------------------------------------------------

// Versions before 0.3 kept the DeepL key in sync storage and had settings that no longer exist.
async function migrateLegacySettings() {
  const legacy = await chrome.storage.sync.get(["deeplAuthKey", "deeplEndpoint", "sourceLang", "cacheMaxEntries"]);
  const legacyKey = String(legacy.deeplAuthKey || "").trim();
  if (legacyKey) {
    const { deeplAuthKey } = await chrome.storage.local.get({ deeplAuthKey: "" });
    if (!deeplAuthKey) await chrome.storage.local.set({ deeplAuthKey: legacyKey });
  }
  const obsolete = Object.keys(legacy);
  if (obsolete.length) await chrome.storage.sync.remove(obsolete);
}

// Open Twitch tabs keep running the previous version's content script until they reload.
// Inject the new one so they pick up the update immediately; it takes over from the old one.
async function injectIntoOpenTabs() {
  const script = chrome.runtime.getManifest().content_scripts?.[0];
  if (!script) return;
  const tabs = await chrome.tabs.query({ url: script.matches });
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: script.js }).catch(() => {
        // Discarded or still-loading tabs get the content script when they load.
      })
    )
  );
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  (async () => {
    await migrateLegacySettings();
    if (reason === "install" || reason === "update") await injectIntoOpenTabs();
  })()
    .catch((error) => console.warn("[TCT] onInstalled:", error))
    .finally(refreshBadgeSafely);
});

chrome.runtime.onStartup.addListener(refreshBadgeSafely);
refreshBadgeSafely();
