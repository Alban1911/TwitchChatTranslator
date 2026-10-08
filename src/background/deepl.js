// DeepL client for the service worker: batches concurrent requests and classifies errors.
(() => {
  const TCT = (globalThis.TCT = globalThis.TCT || {});

  const FREE_ENDPOINT = "https://api-free.deepl.com/v2/translate";
  const PRO_ENDPOINT = "https://api.deepl.com/v2/translate";
  const REQUEST_TIMEOUT_MS = 15_000;
  const BATCH_DELAY_MS = 30;
  const MAX_BATCH_TEXTS = 25;
  const MAX_BATCH_CHARS = 30_000; // DeepL caps request bodies at 128 KiB.

  // Regional variants DeepL prefers over its legacy two-letter targets.
  const TARGET_CODES = { en: "EN-US", pt: "PT-BR", zh: "ZH-HANS", "zh-hant": "ZH-HANT", no: "NB" };

  // Errors that retrying can't fix: translation stops until the settings change.
  const FATAL_CODES = new Set(["no-key", "auth", "quota", "unsupported-target"]);

  class DeeplError extends Error {
    constructor(code, message, retryAfterMs = 0) {
      super(message);
      this.name = "DeeplError";
      this.code = code;
      this.retryAfterMs = retryAfterMs;
    }
  }

  function targetCode(lang) {
    const key = String(lang || "en").toLowerCase();
    return TARGET_CODES[key] || key.toUpperCase();
  }

  // DeepL Free keys end in ":fx"; everything else is a Pro key.
  function endpointFor(authKey) {
    return authKey.endsWith(":fx") ? FREE_ENDPOINT : PRO_ENDPOINT;
  }

  function parseRetryAfter(header) {
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }

  async function errorFromResponse(res) {
    const raw = await res.text().catch(() => "");
    let detail = raw.slice(0, 200);
    try {
      const body = JSON.parse(raw);
      detail = body?.message || body?.error?.message || detail;
    } catch {
      // Not JSON; keep the raw text.
    }
    const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
    switch (res.status) {
      case 403:
        return new DeeplError("auth", "DeepL rejected the API key. Check it in the extension options.");
      case 456:
        return new DeeplError("quota", "Your DeepL character quota is used up for this billing period.");
      case 429:
      case 529:
        return new DeeplError("rate-limit", "DeepL is rate-limiting requests; retrying shortly.", retryAfterMs);
      case 400:
        return /target_lang/i.test(detail)
          ? new DeeplError("unsupported-target", "DeepL can't translate into the selected language.")
          : new DeeplError("bad-request", `DeepL refused the message: ${detail || "bad request"}`);
      case 413:
      case 414:
        return new DeeplError("bad-request", "Message too long for DeepL.");
      default:
        return new DeeplError("server", `DeepL error ${res.status}${detail ? `: ${detail}` : ""}`, retryAfterMs);
    }
  }

  async function request(authKey, texts, targetLang) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(endpointFor(authKey), {
        method: "POST",
        headers: {
          // Since November 2025 DeepL only accepts the key in this header.
          Authorization: `DeepL-Auth-Key ${authKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: texts,
          target_lang: targetCode(targetLang),
          // Emotes, mentions and links travel as <x id="n"/> tags so they stay where they belong.
          tag_handling: "xml",
          // Chat is informal: don't "fix" capitalization or punctuation.
          preserve_formatting: true,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw error?.name === "AbortError"
        ? new DeeplError("timeout", "DeepL didn't respond in time.")
        : new DeeplError("network", "Couldn't reach DeepL. Check your connection.");
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw await errorFromResponse(res);

    const json = await res.json().catch(() => null);
    const translations = json?.translations;
    if (!Array.isArray(translations) || translations.length !== texts.length) {
      throw new DeeplError("server", "DeepL sent an unexpected response.");
    }
    return translations.map((t) => ({
      text: String(t?.text ?? ""),
      detectedSourceLang: String(t?.detected_source_language || "").toLowerCase(),
    }));
  }

  // The popup shows the last fatal error; a successful request clears it.
  let statusClean = false;
  async function reportStatus(error) {
    try {
      if (error && FATAL_CODES.has(error.code)) {
        statusClean = false;
        await chrome.storage.session.set({
          deeplStatus: { code: error.code, message: error.message, at: Date.now() },
        });
      } else if (!error && !statusClean) {
        statusClean = true;
        await chrome.storage.session.remove("deeplStatus");
      }
    } catch {
      // Status is best effort.
    }
  }

  // Messages from every Twitch tab are collected for a moment and sent as one request,
  // which keeps busy chats well under DeepL's rate limits.
  const pending = [];
  let flushTimer = 0;

  function translate(text, targetLang) {
    return new Promise((resolve, reject) => {
      pending.push({ text, targetLang, resolve, reject });
      if (pending.length >= MAX_BATCH_TEXTS) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, BATCH_DELAY_MS);
    });
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    const byTarget = new Map();
    for (const item of pending.splice(0)) {
      const group = byTarget.get(item.targetLang) || [];
      group.push(item);
      byTarget.set(item.targetLang, group);
    }
    for (const group of byTarget.values()) {
      let batch = [];
      let chars = 0;
      for (const item of group) {
        if (batch.length && (batch.length >= MAX_BATCH_TEXTS || chars + item.text.length > MAX_BATCH_CHARS)) {
          sendBatch(batch);
          batch = [];
          chars = 0;
        }
        batch.push(item);
        chars += item.text.length;
      }
      if (batch.length) sendBatch(batch);
    }
  }

  async function sendBatch(items) {
    try {
      const { deeplAuthKey } = await chrome.storage.local.get({ deeplAuthKey: "" });
      const authKey = String(deeplAuthKey || "").trim();
      if (!authKey) throw new DeeplError("no-key", "Add your DeepL API key in the extension options.");
      const results = await request(authKey, items.map((item) => item.text), items[0].targetLang);
      reportStatus(null);
      items.forEach((item, i) => item.resolve(results[i]));
    } catch (error) {
      const deeplError =
        error instanceof DeeplError ? error : new DeeplError("server", String(error?.message || error));
      reportStatus(deeplError);
      items.forEach((item) => item.reject(deeplError));
    }
  }

  /** Errors cross the extension messaging boundary as plain objects. */
  function toPlainError(error) {
    const code = error?.code || "server";
    return {
      code,
      message: String(error?.message || error),
      retryAfterMs: error?.retryAfterMs || 0,
      fatal: FATAL_CODES.has(code),
    };
  }

  TCT.deepl = Object.freeze({ translate, toPlainError, targetCode, endpointFor });
})();
