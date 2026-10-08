const { settings: Settings, lang } = TCT;

const $ = (id) => document.getElementById(id);

let savedTimer = 0;
function flashSaved() {
  $("saved").classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $("saved").classList.remove("show"), 900);
}

async function save(patch) {
  try {
    await Settings.save(patch);
    flashSaved();
  } catch (error) {
    setTestStatus(`Couldn't save: ${error?.message || error}`, { error: true });
  }
}

function setTestStatus(text, { error = false } = {}) {
  $("testStatus").textContent = text;
  $("testStatus").classList.toggle("error", error);
}

function describeKey(key) {
  if (!key) return "Not set.";
  return key.endsWith(":fx") ? "DeepL API Free key." : "DeepL API Pro key.";
}

function showLocalSupport() {
  const supported = typeof globalThis.Translator?.create === "function";
  const el = $("localSupport");
  el.textContent = supported ? " Available in this browser." : " Not available in this browser (needs Chrome 138+ on desktop).";
  el.classList.toggle("ok", supported);
  el.classList.toggle("error", !supported);
}

// ---- Test ---------------------------------------------------------------------------
// Uses the same engines as the Twitch page. A click on "Translate" also lets Chrome download the
// on-device models; Chrome remembers them per site, so twitch.tv still asks once on its own.

const localEngine = TCT.createLocalEngine({ onChange: showDownloadProgress });
const deeplEngine = TCT.createDeeplEngine();
let testing = false;

function showDownloadProgress() {
  if (!testing) return;
  const { downloading } = localEngine.getStatus();
  if (!downloading.length) return;
  const items = downloading.map(({ label, progress }) =>
    progress == null ? label : `${label} ${Math.round(progress * 100)}%`
  );
  setTestStatus(`Downloading ${items.join(", ")}…`);
}

function waitForModel(slotKey) {
  return new Promise((resolve) => {
    const check = () => {
      if (localEngine.slotState(slotKey) !== "creating") resolve();
      else setTimeout(check, 250);
    };
    check();
  });
}

async function translateWithLocal(message, targetLang) {
  if (!localEngine.isSupported()) {
    throw new Error("This browser has no on-device translator (needs Chrome 138 or newer on desktop).");
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await localEngine.translate(message, targetLang);
    } catch (error) {
      if (error?.name !== "ModelNotReadyError") throw error;
      if (localEngine.slotState(error.slotKey) === "needs-gesture") {
        throw new Error("Chrome needs one more click to download the model. Press Translate again.");
      }
      await waitForModel(error.slotKey);
    }
  }
  throw new Error("The on-device model isn't ready yet. Try again in a moment.");
}

const SKIP_REASONS = {
  "same-language": "Already in the target language, so messages like this are left as they are.",
  "unknown-language": "Couldn't tell which language this is. Short messages are skipped; try a full sentence.",
  "unsupported-language": "This language isn't supported by the on-device translator.",
};

async function runTest() {
  const text = $("testText").value.trim();
  if (!text) return;
  const s = await Settings.load();
  const message = { parts: [{ type: "text", text }], verbatim: [], text, signature: text };
  testing = true;
  $("test").disabled = true;
  $("testResult").textContent = "";
  setTestStatus("Translating…");
  try {
    const started = performance.now();
    const result =
      s.engine === "local" ? await translateWithLocal(message, s.targetLang) : await deeplEngine.translate(message, s.targetLang);
    const ms = performance.now() - started;
    const took = ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
    const from = result.sourceLang ? lang.name(result.sourceLang) : "unknown";
    if (result.skip) {
      setTestStatus(SKIP_REASONS[result.skip] || `Skipped (${result.skip}).`);
      $("testResult").textContent = `Detected: ${from}`;
      return;
    }
    const output = result.segments.filter((segment) => typeof segment === "string").join("");
    setTestStatus(`Done in ${took} with ${s.engine === "local" ? "the on-device engine" : "DeepL"}.`);
    $("testResult").textContent = `${from} → ${lang.name(s.targetLang)}\n${output}`;
  } catch (error) {
    setTestStatus(String(error?.message || error), { error: true });
  } finally {
    testing = false;
    $("test").disabled = false;
  }
}

// ---- Form -----------------------------------------------------------------------------

async function init() {
  for (const { code, name } of Settings.LANGUAGES) $("targetLang").add(new Option(name, code));
  showLocalSupport();

  const s = await Settings.load();
  $("enabled").checked = s.enabled;
  for (const radio of document.querySelectorAll('input[name="engine"]')) radio.checked = radio.value === s.engine;
  $("targetLang").value = s.targetLang;
  $("displayMode").value = s.displayMode;
  $("showSourceLang").checked = s.showSourceLang;
  $("deeplAuthKey").value = s.deeplAuthKey;
  $("keyInfo").textContent = describeKey(s.deeplAuthKey);
  $("deeplFallback").checked = s.deeplFallback;
  $("debug").checked = s.debug;

  for (const id of ["enabled", "showSourceLang", "deeplFallback", "debug"]) {
    $(id).addEventListener("change", () => save({ [id]: $(id).checked }));
  }
  for (const id of ["targetLang", "displayMode"]) {
    $(id).addEventListener("change", () => save({ [id]: $(id).value }));
  }
  for (const radio of document.querySelectorAll('input[name="engine"]')) {
    radio.addEventListener("change", () => radio.checked && save({ engine: radio.value }));
  }
  $("deeplAuthKey").addEventListener("change", () => {
    const key = $("deeplAuthKey").value.trim();
    $("deeplAuthKey").value = key;
    $("keyInfo").textContent = describeKey(key);
    save({ deeplAuthKey: key });
  });
  $("toggleKey").addEventListener("click", () => {
    const input = $("deeplAuthKey");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("toggleKey").textContent = show ? "Hide" : "Show";
  });
  $("test").addEventListener("click", runTest);

  // Keep the form in sync when the popup changes something.
  Settings.subscribe(async () => {
    const latest = await Settings.load();
    $("enabled").checked = latest.enabled;
    for (const radio of document.querySelectorAll('input[name="engine"]')) radio.checked = radio.value === latest.engine;
    $("targetLang").value = latest.targetLang;
    $("displayMode").value = latest.displayMode;
  });
}

init().catch((error) => setTestStatus(`Couldn't load settings: ${error?.message || error}`, { error: true }));
