const { settings: Settings, MSG } = TCT;

const $ = (id) => document.getElementById(id);

let savedTimer = 0;
function flashSaved() {
  $("saved").textContent = "Saved";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($("saved").textContent = ""), 900);
}

function syncEnabledLabel() {
  $("enabledLabel").textContent = $("enabled").checked ? "On" : "Off";
}

function setStatus(text, { error = false } = {}) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", error);
}

async function activeTwitchTabStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // tab.url is only visible for sites we have host permissions for, i.e. Twitch.
  if (!tab?.id || !TCT.isTwitchUrl(tab.url)) return { onTwitch: false };
  try {
    return { onTwitch: true, status: await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_TAB_STATUS }) };
  } catch {
    return { onTwitch: true, status: null }; // No content script: the tab predates the install.
  }
}

async function refreshStatus() {
  const [s, { onTwitch, status }, { deeplStatus }] = await Promise.all([
    Settings.load(),
    activeTwitchTabStatus(),
    chrome.storage.session.get("deeplStatus"),
  ]);

  if (!s.enabled) return setStatus("Turn the translator on to translate Twitch chat.");
  if (s.engine === "deepl" && !s.deeplAuthKey) {
    return setStatus("Add your DeepL API key in Options to use DeepL.", { error: true });
  }
  if (s.engine === "local" && !s.deeplFallback && typeof globalThis.Translator?.create !== "function") {
    return setStatus("This browser has no on-device translator (needs Chrome 138+ on desktop). Choose DeepL.", {
      error: true,
    });
  }
  if ((s.engine === "deepl" || s.deeplFallback) && deeplStatus) {
    return setStatus(deeplStatus.message, { error: true });
  }
  if (!onTwitch) return setStatus("Open a Twitch channel or popout chat to see translations.");
  if (!status) return setStatus("Reload this Twitch tab to start translating.");

  const { local, pipeline } = status;
  if (pipeline?.halted) return setStatus(pipeline.halted.message, { error: true });
  if (s.engine === "local") {
    if (local.downloading.length) {
      const items = local.downloading.map(({ label, progress }) =>
        progress == null ? label : `${label} ${Math.round(progress * 100)}%`
      );
      return setStatus(`Downloading ${items.join(", ")}…`);
    }
    if (local.needsGesture.length) {
      return setStatus(`Click anywhere on the Twitch page to download ${local.needsGesture.join(", ")} (one time).`);
    }
  }
  if (!status.chatFound) return setStatus("Waiting for chat messages…");
  const shown = status.shown || 0;
  if (!shown && (pipeline?.translated || 0) > 2) {
    return setStatus(
      "Messages are translated but none show up on the page. Another chat extension may be drawing the chat " +
        "(7TV, BetterTTV and FrankerFaceZ are supported). Turn on debug logging in Options to see more.",
      { error: true }
    );
  }
  const engine = s.engine === "local" ? "on-device" : "DeepL";
  setStatus(
    shown
      ? `Translating with ${engine} · ${shown} message${shown === 1 ? "" : "s"} so far.`
      : `Translating with ${engine}. Messages already in your language are left alone.`
  );
}

async function init() {
  for (const { code, name } of Settings.LANGUAGES) $("targetLang").add(new Option(name, code));

  const s = await Settings.load();
  $("enabled").checked = s.enabled;
  $("engine").value = s.engine;
  $("targetLang").value = s.targetLang;
  $("displayMode").value = s.displayMode;
  syncEnabledLabel();

  const bind = (id, read) => {
    $(id).addEventListener("change", async () => {
      if (id === "enabled") syncEnabledLabel();
      await Settings.save({ [id]: read($(id)) });
      flashSaved();
      refreshStatus();
    });
  };
  bind("enabled", (el) => el.checked);
  bind("engine", (el) => el.value);
  bind("targetLang", (el) => el.value);
  bind("displayMode", (el) => el.value);

  $("openOptions").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  await refreshStatus();
  setInterval(() => refreshStatus().catch(() => {}), 1000);
}

init().catch((error) => setStatus(String(error?.message || error), { error: true }));
