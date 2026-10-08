// Settings, languages and message types shared by every part of the extension.
// Loaded as a classic script by the service worker, the content scripts and the extension pages.
(() => {
  const TCT = (globalThis.TCT = globalThis.TCT || {});

  /** Synced across the user's browsers (chrome.storage.sync). */
  const SYNC_DEFAULTS = Object.freeze({
    enabled: false,
    engine: "local", // "local": Chrome's built-in on-device translator. "deepl": DeepL API.
    targetLang: "en",
    displayMode: "under", // "under" | "replace"
    showSourceLang: true,
    deeplFallback: false, // On-device engine only: send messages it can't translate to DeepL.
    debug: false,
  });

  /** Kept on this device only (chrome.storage.local), because it's a secret. */
  const LOCAL_DEFAULTS = Object.freeze({
    deeplAuthKey: "",
  });

  const ENGINES = ["local", "deepl"];
  const DISPLAY_MODES = ["under", "replace"];

  /** Target languages: everything Chrome's on-device translator supports. */
  const LANGUAGES = Object.freeze(
    [
      ["ar", "Arabic"],
      ["bn", "Bengali"],
      ["bg", "Bulgarian"],
      ["zh", "Chinese (Simplified)"],
      ["zh-Hant", "Chinese (Traditional)"],
      ["hr", "Croatian"],
      ["cs", "Czech"],
      ["da", "Danish"],
      ["nl", "Dutch"],
      ["en", "English"],
      ["fi", "Finnish"],
      ["fr", "French"],
      ["de", "German"],
      ["el", "Greek"],
      ["he", "Hebrew"],
      ["hi", "Hindi"],
      ["hu", "Hungarian"],
      ["id", "Indonesian"],
      ["it", "Italian"],
      ["ja", "Japanese"],
      ["kn", "Kannada"],
      ["ko", "Korean"],
      ["lt", "Lithuanian"],
      ["mr", "Marathi"],
      ["no", "Norwegian"],
      ["pl", "Polish"],
      ["pt", "Portuguese"],
      ["ro", "Romanian"],
      ["ru", "Russian"],
      ["sk", "Slovak"],
      ["sl", "Slovenian"],
      ["es", "Spanish"],
      ["sv", "Swedish"],
      ["ta", "Tamil"],
      ["te", "Telugu"],
      ["th", "Thai"],
      ["tr", "Turkish"],
      ["uk", "Ukrainian"],
      ["vi", "Vietnamese"],
    ].map(([code, name]) => Object.freeze({ code, name }))
  );

  const displayNames = (() => {
    try {
      return new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      return null;
    }
  })();

  function languageName(code) {
    const known = LANGUAGES.find((lang) => lang.code === code);
    if (known) return known.name;
    try {
      return displayNames?.of(code) || code;
    } catch {
      return code;
    }
  }

  /** "pt-BR" → "pt". Norwegian Bokmål/Nynorsk map to "no", the code Chrome's translator uses. */
  function baseLanguage(tag) {
    const base = String(tag || "").toLowerCase().split(/[-_]/)[0];
    return base === "nb" || base === "nn" ? "no" : base;
  }

  function sameLanguage(a, b) {
    return !!a && !!b && baseLanguage(a) === baseLanguage(b);
  }

  function sanitize(raw) {
    const s = { ...SYNC_DEFAULTS, ...LOCAL_DEFAULTS, ...raw };
    if (!ENGINES.includes(s.engine)) s.engine = SYNC_DEFAULTS.engine;
    if (!DISPLAY_MODES.includes(s.displayMode)) s.displayMode = SYNC_DEFAULTS.displayMode;
    if (!LANGUAGES.some((lang) => lang.code === s.targetLang)) s.targetLang = SYNC_DEFAULTS.targetLang;
    for (const key of ["enabled", "showSourceLang", "deeplFallback", "debug"]) s[key] = !!s[key];
    s.deeplAuthKey = String(s.deeplAuthKey || "").trim();
    return s;
  }

  /** Content scripts pass `secrets: false`: they never need the DeepL key. */
  async function load({ secrets = true } = {}) {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(SYNC_DEFAULTS),
      secrets ? chrome.storage.local.get(LOCAL_DEFAULTS) : LOCAL_DEFAULTS,
    ]);
    return sanitize({ ...sync, ...local });
  }

  async function save(patch) {
    const sync = {};
    const local = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key in SYNC_DEFAULTS) sync[key] = value;
      else if (key in LOCAL_DEFAULTS) local[key] = value;
    }
    const writes = [];
    if (Object.keys(sync).length) writes.push(chrome.storage.sync.set(sync));
    if (Object.keys(local).length) writes.push(chrome.storage.local.set(local));
    await Promise.all(writes);
  }

  /** Calls `listener(changedKeys)` whenever a setting changes, wherever it was changed from. */
  function subscribe(listener) {
    const onChanged = (changes, area) => {
      const defaults = area === "sync" ? SYNC_DEFAULTS : area === "local" ? LOCAL_DEFAULTS : null;
      if (!defaults) return;
      const keys = Object.keys(changes).filter((key) => key in defaults);
      if (keys.length) listener(keys);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }

  TCT.settings = Object.freeze({
    SYNC_DEFAULTS,
    LOCAL_DEFAULTS,
    LANGUAGES,
    load,
    save,
    subscribe,
  });

  TCT.lang = Object.freeze({ name: languageName, base: baseLanguage, same: sameLanguage });

  TCT.MSG = Object.freeze({
    DEEPL_TRANSLATE: "tct:deepl-translate", // content script / options page → service worker
    GET_TAB_STATUS: "tct:get-tab-status", // popup → content script
  });

  TCT.isTwitchUrl = (url) => /^https:\/\/www\.twitch\.tv\//.test(String(url || ""));
})();
