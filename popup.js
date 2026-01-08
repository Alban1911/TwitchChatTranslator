const DEFAULT_SETTINGS = {
  enabled: true,
  targetLang: "en",
  displayMode: "under", // "under" | "replace"
};

const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $("status").textContent = text || "";
}

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  $("enabled").checked = !!settings.enabled;
  $("targetLang").value = settings.targetLang || "en";
  $("displayMode").value = settings.displayMode || "under";
}

async function save(patch) {
  await chrome.storage.sync.set(patch);
}

function wire() {
  $("enabled").addEventListener("change", async () => {
    setStatus("Saving…");
    await save({ enabled: $("enabled").checked });
    setStatus("Saved");
    setTimeout(() => setStatus(""), 800);
  });

  $("targetLang").addEventListener("change", async () => {
    setStatus("Saving…");
    await save({ targetLang: $("targetLang").value });
    setStatus("Saved");
    setTimeout(() => setStatus(""), 800);
  });

  $("displayMode").addEventListener("change", async () => {
    setStatus("Saving…");
    await save({ displayMode: $("displayMode").value });
    setStatus("Saved");
    setTimeout(() => setStatus(""), 800);
  });

  $("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

load()
  .then(wire)
  .catch((e) => {
    setStatus(String(e?.message || e));
  });


