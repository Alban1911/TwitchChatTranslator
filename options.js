const DEFAULT_SETTINGS = {
  enabled: true,
  displayMode: "under", // "under" | "replace"
  deeplEndpoint: "https://api-free.deepl.com/v2/translate",
  deeplAuthKey: "",
  targetLang: "en",
  sourceLang: "auto",
  cacheMaxEntries: 2000,
};

const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $("status").textContent = text || "";
}

function setTestResult(text) {
  $("testResult").textContent = text || "";
}

function readForm() {
  return {
    enabled: $("enabled").checked,
    targetLang: $("targetLang").value,
    displayMode: $("displayMode").value,
    deeplEndpoint: $("deeplEndpoint").value,
    deeplAuthKey: $("deeplAuthKey").value,
  };
}

function writeForm(settings) {
  $("enabled").checked = !!settings.enabled;
  $("targetLang").value = settings.targetLang || "en";
  $("displayMode").value = settings.displayMode || "under";
  $("deeplEndpoint").value =
    settings.deeplEndpoint || DEFAULT_SETTINGS.deeplEndpoint;
  $("deeplAuthKey").value = settings.deeplAuthKey || "";
}

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  writeForm(settings);
}

async function save() {
  const payload = readForm();
  await chrome.storage.sync.set(payload);
}

$("save").addEventListener("click", async () => {
  setStatus("Saving…");
  setTestResult("");
  try {
    await save();
    setStatus("Saved.");
  } catch (e) {
    setStatus(`Save failed: ${String(e?.message || e)}`);
  }
});

$("test").addEventListener("click", async () => {
  setStatus("Testing…");
  setTestResult("");
  try {
    await save();

    const sample = "Hello chat, this is a translation test!";
    const res = await chrome.runtime.sendMessage({
      type: "TRANSLATE",
      text: sample,
    });

    if (!res?.ok) {
      setStatus("Test failed.");
      setTestResult(res?.error || "Unknown error");
      return;
    }

    setStatus(res.cached ? "OK (cached)." : "OK.");
    setTestResult(`Input:  ${sample}\nOutput: ${res.translatedText}`);
  } catch (e) {
    setStatus("Test failed.");
    setTestResult(String(e?.message || e));
  }
});

load().catch((e) => {
  setStatus(`Failed to load: ${String(e?.message || e)}`);
});


