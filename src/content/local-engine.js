// On-device translation with Chrome's built-in Translator and LanguageDetector APIs (Chrome 138+).
//
// Chrome downloads a model per language pair (plus one for language detection) the first time a
// site uses it, and only lets `create()` start that download during a user gesture. So the first
// message in a new language parks until the user clicks or types anywhere on the page; after that
// Chrome remembers the pair for twitch.tv and it works immediately.
(() => {
  const TCT = (globalThis.TCT = globalThis.TCT || {});

  // Chat is full of "lol", "gg" and emote names; ignore detections the model isn't sure about.
  const MIN_CONFIDENCE = 0.7;
  // Chats are dominated by a few languages. A confident-looking guess on a short message for a
  // language nobody else in this chat writes is usually slang or a name ("bastion ulted" → Danish),
  // so short messages in languages that are rare in the chat (or before we know the chat) need a
  // much surer detection. Longer messages are detected reliably.
  const RARE_LANGUAGE_CONFIDENCE = 0.9;
  const COMMON_LANGUAGE_SHARE = 0.1;
  const LANGUAGE_HISTORY_SIZE = 60;
  const LANGUAGE_HISTORY_WARMUP = 10;
  const LONG_MESSAGE_WORDS = 5;
  // chrome.i18n.detectLanguage, used when LanguageDetector is unavailable, guesses wildly on short
  // Latin-script text ("merci pour le stream" → Italian), so it only gets longer messages.
  const FALLBACK_MIN_WORDS = 4;
  const FALLBACK_MIN_LETTERS = 20;
  const FALLBACK_MIN_NON_LATIN = 3;
  const RETRY_FAILED_AFTER_MS = 60_000;
  // Give up on a model if clicking still doesn't let Chrome download it (e.g. blocked by policy).
  const MAX_GESTURE_ATTEMPTS = 3;
  // Chrome's models occasionally fail with a generic error. A session that keeps failing is rebuilt.
  const MAX_CONSECUTIVE_FAILURES = 3;
  const TRANSIENT_MODEL_ERRORS = new Set(["UnknownError", "OperationError"]);

  function isSupported() {
    return typeof globalThis.Translator?.create === "function";
  }

  function hasLanguageDetector() {
    return typeof globalThis.LanguageDetector?.create === "function";
  }

  /** The model is waiting for a user gesture or still being created; retry once it's ready. */
  class ModelNotReadyError extends Error {
    constructor(slot) {
      super(`${slot.label} model isn't ready (${slot.state})`);
      this.name = "ModelNotReadyError";
      this.slotKey = slot.key;
    }
  }

  /** Maps a detected tag to a code Chrome's translator accepts, or null for romanized text ("hi-Latn"). */
  function toTranslatorLanguage(tag) {
    const [base, ...subtags] = String(tag || "").toLowerCase().split("-");
    if (!base || base === "und" || subtags.includes("latn")) return null;
    if (base === "zh") return subtags.includes("hant") ? "zh-Hant" : "zh";
    return TCT.lang.base(base);
  }

  async function detectWithI18n(text) {
    if (typeof chrome.i18n?.detectLanguage !== "function") return null;
    const words = text.split(/\s+/).filter(Boolean).length;
    const letters = (text.match(/\p{L}/gu) || []).length;
    const nonLatin = (text.match(/(?!\p{Script=Latin})\p{L}/gu) || []).length;
    const longEnough = (words >= FALLBACK_MIN_WORDS && letters >= FALLBACK_MIN_LETTERS) || nonLatin >= FALLBACK_MIN_NON_LATIN;
    if (!longEnough) return null;
    const { languages } = await chrome.i18n.detectLanguage(text);
    const top = languages?.[0];
    return top && top.language !== "und" ? { lang: top.language, confidence: top.percentage / 100 } : null;
  }

  async function translateText(translator, text) {
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (!/\p{L}/u.test(core)) return text;
    let translated;
    try {
      translated = await translator.translate(core);
    } catch (error) {
      if (!TRANSIENT_MODEL_ERRORS.has(error?.name)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
      translated = await translator.translate(core);
    }
    return lead + translated + trail;
  }

  function createLocalEngine({ onChange = () => {}, log = () => {} } = {}) {
    // A "slot" is one lazily created model session: the detector or a translator for one pair.
    // States: idle → creating → ready | needs-gesture | unsupported | failed | declined
    const slots = new Map();
    let destroyed = false;

    function slotFor(key, label, availability, create) {
      let slot = slots.get(key);
      if (!slot) {
        slot = { key, label, availability, create, state: "idle", instance: null, progress: null };
        slot.error = null;
        slot.failedAt = 0;
        slot.gestureAttempts = 0;
        slot.failures = 0;
        slots.set(key, slot);
      }
      return slot;
    }

    function setState(slot, state) {
      if (slot.state === state) return;
      slot.state = state;
      log(`model ${slot.label}: ${state}`);
      onChange();
    }

    async function instantiate(slot, { gesture = false } = {}) {
      slot.viaGesture = gesture; // A gesture means Chrome is about to download the model.
      setState(slot, "creating");
      try {
        // During a gesture, call create() synchronously so the user activation is still fresh.
        if (!gesture && (await slot.availability()) === "unavailable") {
          setState(slot, "unsupported");
          return null;
        }
        const instance = await slot.create((monitor) => {
          monitor.addEventListener("downloadprogress", (event) => {
            slot.progress = event.loaded;
            onChange();
          });
        });
        slot.progress = null;
        if (destroyed) {
          instance.destroy?.();
          return null;
        }
        slot.instance = instance;
        setState(slot, "ready");
        return instance;
      } catch (error) {
        slot.progress = null;
        if (error?.name === "NotAllowedError") {
          if (gesture && ++slot.gestureAttempts >= MAX_GESTURE_ATTEMPTS) {
            log(`model ${slot.label}: Chrome keeps refusing the download`, error);
            setState(slot, "unsupported");
            return null;
          }
          setState(slot, "needs-gesture");
          throw new ModelNotReadyError(slot);
        }
        if (error?.name === "NotSupportedError") {
          setState(slot, "unsupported");
          return null;
        }
        slot.error = error;
        slot.failedAt = Date.now();
        setState(slot, "failed");
        throw error;
      }
    }

    /**
     * Resolves to the model session, or null when this device can't provide it. While another
     * caller is creating the session (possibly a long download), rejects with ModelNotReadyError
     * instead of waiting, so messages in languages that are ready keep flowing.
     */
    function acquire(slot) {
      switch (slot.state) {
        case "ready":
          return Promise.resolve(slot.instance);
        case "unsupported":
        case "declined":
          return Promise.resolve(null);
        case "needs-gesture":
        case "creating":
          return Promise.reject(new ModelNotReadyError(slot));
        case "failed":
          if (Date.now() - slot.failedAt < RETRY_FAILED_AFTER_MS) return Promise.reject(slot.error);
          break;
      }
      return instantiate(slot);
    }

    /** Runs `fn` with the slot's session; a session that keeps failing is dropped and rebuilt. */
    async function useSlot(slot, fn) {
      const instance = slot.instance;
      try {
        const result = await fn(instance);
        slot.failures = 0;
        return result;
      } catch (error) {
        if (++slot.failures >= MAX_CONSECUTIVE_FAILURES && slot.instance === instance) {
          log(`model ${slot.label}: keeps failing, rebuilding it`, error);
          try {
            instance?.destroy?.();
          } catch {
            // Already broken.
          }
          slot.instance = null;
          slot.failures = 0;
          setState(slot, "idle");
        }
        throw error;
      }
    }

    function onGesture(event) {
      const noGesture = TCT.dom?.NO_GESTURE_ATTR; // Not loaded on the options page.
      if (noGesture && event.target?.closest?.(`[${noGesture}]`)) return;
      for (const slot of slots.values()) {
        if (slot.state === "needs-gesture") instantiate(slot, { gesture: true }).catch(() => {});
      }
    }
    addEventListener("pointerdown", onGesture, true);
    addEventListener("keydown", onGesture, true);

    function detectorSlot() {
      return slotFor(
        "detector",
        "language detection",
        () => LanguageDetector.availability(),
        (monitor) => LanguageDetector.create({ monitor })
      );
    }

    function translatorSlot(source, target) {
      return slotFor(
        `${source}>${target}`,
        `${TCT.lang.name(source)} → ${TCT.lang.name(target)}`,
        () => Translator.availability({ sourceLanguage: source, targetLanguage: target }),
        (monitor) => Translator.create({ sourceLanguage: source, targetLanguage: target, monitor })
      );
    }

    // Languages of recent confident detections in this chat.
    const languageHistory = [];

    function requiredConfidence(lang, text, minConfidence) {
      const strict = Math.max(minConfidence, RARE_LANGUAGE_CONFIDENCE);
      if (text.split(/\s+/).length >= LONG_MESSAGE_WORDS) return minConfidence;
      if (languageHistory.length < LANGUAGE_HISTORY_WARMUP) return strict;
      const share = languageHistory.filter((seen) => seen === lang).length / languageHistory.length;
      return share >= COMMON_LANGUAGE_SHARE ? minConfidence : strict;
    }

    /** A different chat (e.g. after navigating to another channel) has its own languages. */
    function resetLanguageHistory() {
      languageHistory.length = 0;
    }

    /** Returns `{ lang, confidence }`, or null when the language can't be told reliably. */
    async function detect(text, minConfidence = MIN_CONFIDENCE) {
      const slot = hasLanguageDetector() ? detectorSlot() : null;
      const detector = slot ? await acquire(slot) : null;
      if (!detector) return detectWithI18n(text);
      const [top] = await useSlot(slot, (session) => session.detect(text));
      if (!top || top.detectedLanguage === "und") return null;
      const lang = TCT.lang.base(top.detectedLanguage);
      if (top.confidence >= RARE_LANGUAGE_CONFIDENCE) {
        languageHistory.push(lang);
        if (languageHistory.length > LANGUAGE_HISTORY_SIZE) languageHistory.shift();
      }
      if (top.confidence < requiredConfidence(lang, text, minConfidence)) return null;
      return { lang: top.detectedLanguage, confidence: top.confidence };
    }

    /**
     * Translates a message read by TCT.dom.readMessage. Resolves to `{ segments, sourceLang }`, or
     * `{ skip }` when there's nothing to do. Rejects with ModelNotReadyError while a model waits
     * for the user's click or is downloading.
     */
    async function translate(message, targetLang) {
      const detected = await detect(message.text);
      if (!detected) return { skip: "unknown-language" };
      const source = toTranslatorLanguage(detected.lang);
      if (!source) return { skip: "unsupported-language", sourceLang: detected.lang };
      if (TCT.lang.same(source, targetLang)) return { skip: "same-language", sourceLang: source };

      const slot = translatorSlot(source, targetLang);
      if (!(await acquire(slot))) return { skip: "unsupported-language", sourceLang: source };

      // Translate the text between emotes/mentions separately so they stay exactly in place.
      const segments = await useSlot(slot, async (translator) => {
        const out = [];
        let verbatimIndex = 0;
        for (const part of message.parts) {
          out.push(part.type === "text" ? await translateText(translator, part.text) : verbatimIndex++);
        }
        return out;
      });
      return { segments, sourceLang: source };
    }

    function slotState(key) {
      return slots.get(key)?.state || "idle";
    }

    /** The user dismissed the download prompt: stop asking for these models on this page. */
    function declinePending() {
      for (const slot of slots.values()) {
        if (slot.state === "needs-gesture") slot.state = "declined";
      }
      onChange();
    }

    function getStatus() {
      const list = [...slots.values()];
      return {
        supported: isSupported(),
        needsGesture: list.filter((slot) => slot.state === "needs-gesture").map((slot) => slot.label),
        downloading: list
          .filter((slot) => slot.state === "creating" && (slot.viaGesture || slot.progress != null))
          .map((slot) => ({ label: slot.label, progress: slot.progress })),
        failed: list.filter((slot) => slot.state === "failed").map((slot) => slot.label),
      };
    }

    function destroy() {
      destroyed = true;
      removeEventListener("pointerdown", onGesture, true);
      removeEventListener("keydown", onGesture, true);
      for (const slot of slots.values()) {
        try {
          slot.instance?.destroy?.();
        } catch {
          // Already gone.
        }
      }
      slots.clear();
    }

    return { isSupported, detect, translate, slotState, declinePending, resetLanguageHistory, getStatus, destroy };
  }

  TCT.isLocalSupported = isSupported;
  TCT.createLocalEngine = createLocalEngine;
})();
