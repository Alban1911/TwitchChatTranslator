const DEFAULT_SETTINGS = {
  enabled: false,
  deeplEndpoint: "https://api-free.deepl.com/v2/translate",
  deeplAuthKey: "",
  targetLang: "en",
  sourceLang: "auto",
  cacheMaxEntries: 2000,
};

/**
 * Simple LRU-ish cache: Map preserves insertion order.
 * Key: `${target}|${source}|${text}`
 */
const cache = new Map();

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const val = cache.get(key);
  // refresh recency
  cache.delete(key);
  cache.set(key, val);
  return val;
}

function cacheSet(key, val, maxEntries) {
  cache.set(key, val);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

async function getSettings() {
  return await chrome.storage.sync.get(DEFAULT_SETTINGS);
}

function normalizeDeeplLang(lang) {
  if (!lang) return null;
  // DeepL expects uppercase, and supports regional variants like EN-GB, PT-BR, etc.
  return String(lang).trim().replace("_", "-").toUpperCase();
}

async function translateDeepL({ endpoint, authKey, text, source, target }) {
  const key = String(authKey || "").trim();
  if (!key) throw new Error("DeepL auth key is required (set it in Options)");

  const params = new URLSearchParams();
  params.set("auth_key", key);
  params.append("text", text);
  params.set("target_lang", normalizeDeeplLang(target) || "EN");

  const src = normalizeDeeplLang(source);
  if (src && src !== "AUTO") {
    params.set("source_lang", src);
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `DeepL request failed (${res.status} ${res.statusText}) ${errText}`.trim()
    );
  }

  const json = await res.json();
  const translatedText = json?.translations?.[0]?.text;
  if (typeof translatedText !== "string") {
    throw new Error("Unexpected DeepL response shape");
  }
  return translatedText;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || message.type !== "TRANSLATE") return;

    const { text } = message;
    if (typeof text !== "string" || !text.trim()) {
      sendResponse({ ok: false, error: "Invalid text" });
      return;
    }

    const settings = await getSettings();
    if (!settings.enabled) {
      sendResponse({ ok: false, error: "Disabled" });
      return;
    }

    const source = settings.sourceLang || "auto";
    const target = settings.targetLang || "en";
    const cacheKey = `${target}|${source}|${text}`;

    const cached = cacheGet(cacheKey);
    if (cached) {
      sendResponse({ ok: true, translatedText: cached, cached: true });
      return;
    }

    try {
      const translatedText = await translateDeepL({
        endpoint: settings.deeplEndpoint || DEFAULT_SETTINGS.deeplEndpoint,
        authKey: settings.deeplAuthKey,
        text,
        source,
        target,
      });

      cacheSet(
        cacheKey,
        translatedText,
        Number(settings.cacheMaxEntries) || DEFAULT_SETTINGS.cacheMaxEntries
      );
      sendResponse({ ok: true, translatedText, cached: false });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  // Keep the message channel open for async sendResponse.
  return true;
});


