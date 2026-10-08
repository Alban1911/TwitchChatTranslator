// Translation queue: engine choice, caching, de-duplication, back-pressure, retries and backoff.
(() => {
  const TCT = (globalThis.TCT = globalThis.TCT || {});

  const MAX_QUEUE = 40; // When chat outpaces translation, the newest messages win.
  const MAX_PARKED_PER_MODEL = 20;
  const CACHE_SIZE = 1500;
  const MAX_ATTEMPTS = 3;
  const MAX_BACKOFF_MS = 30_000;
  // Chrome runs on-device translations one at a time; DeepL requests are batched by the worker.
  const CONCURRENCY = { local: 2, deepl: 6 };
  // With DeepL, messages the on-device detector is sure are already in the target language are
  // skipped, which saves a lot of quota in busy chats.
  const DEEPL_SKIP_CONFIDENCE = 0.8;
  const TRANSIENT_CODES = new Set(["rate-limit", "server", "network", "timeout"]);

  /** Normalized for "did the translation change anything?" comparisons. */
  function comparable(text) {
    return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function isUnchanged(segments, originalText) {
    const translated = segments.filter((segment) => typeof segment === "string").join(" ");
    return comparable(translated) === comparable(originalText);
  }

  function engineError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.fatal = true;
    return error;
  }

  /**
   * @param {object} deps
   * @param {ReturnType<typeof TCT.createLocalEngine>} deps.local
   * @param {ReturnType<typeof TCT.createDeeplEngine>} deps.deepl
   * @param {(row: Element, message: object) => boolean} deps.isCurrent Whether the row still shows `message`.
   * @param {(row: Element, message: object, result: object) => void} deps.onResult
   * @param {() => void} deps.onChange Status changed (halted, parked, ...).
   * @param {() => void} deps.onInvalidated The extension was reloaded; this content script is orphaned.
   */
  function createPipeline({ local, deepl, isCurrent, onResult, onChange, onInvalidated, log }) {
    let settings = null;
    const queue = []; // Newest last.
    const parked = new Map(); // model key → jobs waiting for that on-device model
    const cache = new Map(); // LRU: cache key → result
    const inflight = new Map(); // cache key → Promise<result>
    let active = 0;
    let pausedUntil = 0;
    let resumeTimer = 0;
    let halted = null; // { code, message } after a fatal error; cleared by reset()/resume()
    let fallbackBroken = false; // DeepL fallback failed fatally (e.g. no key)
    let translated = 0;
    let generation = 0; // Bumped by reset() so results from older settings are dropped.

    function configure(next) {
      settings = next;
      pump();
    }

    /** Queues a row. Returns false when translation is halted (the row should be retried later). */
    function enqueue(row, message) {
      if (halted) return false;
      queue.push({ row, message, attempts: 0 });
      while (queue.length > MAX_QUEUE) {
        const dropped = queue.shift();
        onResult(dropped.row, dropped.message, { skip: "dropped" });
      }
      pump();
      return true;
    }

    function pump() {
      if (!settings || halted) return;
      const wait = pausedUntil - Date.now();
      if (wait > 0) {
        if (!resumeTimer) {
          resumeTimer = setTimeout(() => {
            resumeTimer = 0;
            pump();
          }, wait);
        }
        return;
      }
      const limit = CONCURRENCY[settings.engine] || 2;
      while (active < limit && queue.length) {
        const job = queue.pop(); // Newest first: that's what people are reading.
        active += 1;
        run(job, generation).finally(() => {
          active -= 1;
          pump();
        });
      }
    }

    async function run(job, gen) {
      if (!job.row.isConnected || !isCurrent(job.row, job.message)) return;
      try {
        const result = await translateCached(job.message);
        if (gen !== generation) return;
        if (!result.skip) translated += 1;
        onResult(job.row, job.message, result);
      } catch (error) {
        if (gen === generation) handleError(job, error);
      }
    }

    function cacheKey(message) {
      const engine = settings.engine === "local" && settings.deeplFallback ? "local+deepl" : settings.engine;
      return `${engine}|${settings.targetLang}|${message.signature}`;
    }

    function translateCached(message) {
      const key = cacheKey(message);
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return Promise.resolve(hit);
      }
      // Copy-pasta and emote spam: identical messages share one request.
      let promise = inflight.get(key);
      if (!promise) {
        promise = translateWithEngine(message, settings)
          .then((result) => {
            cache.set(key, result);
            if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
            return result;
          })
          .finally(() => {
            if (inflight.get(key) === promise) inflight.delete(key);
          });
        inflight.set(key, promise);
      }
      return promise;
    }

    async function translateWithEngine(message, { engine, targetLang, deeplFallback }) {
      let result;
      if (engine === "deepl") {
        const detected = await local.detect(message.text, DEEPL_SKIP_CONFIDENCE).catch(() => null);
        if (detected && TCT.lang.same(detected.lang, targetLang)) return { skip: "same-language", sourceLang: detected.lang };
        result = await deepl.translate(message, targetLang);
      } else if (!local.isSupported()) {
        if (!deeplFallback) {
          throw engineError(
            "local-unsupported",
            "On-device translation needs Chrome 138 or newer on desktop. Switch the engine to DeepL in the extension popup."
          );
        }
        result = await deepl.translate(message, targetLang);
      } else {
        result = await local.translate(message, targetLang);
        if (result.skip === "unsupported-language" && result.sourceLang && deeplFallback && !fallbackBroken) {
          try {
            result = await deepl.translate(message, targetLang);
          } catch (error) {
            if (!error.fatal) throw error;
            fallbackBroken = true; // e.g. no key: keep translating on-device, stop trying DeepL.
            log("DeepL fallback disabled:", error.message);
            onChange();
          }
        }
      }
      if (!result.skip && isUnchanged(result.segments, message.text)) {
        return { skip: "unchanged", sourceLang: result.sourceLang };
      }
      return result;
    }

    function handleError(job, error) {
      if (error?.name === "ModelNotReadyError") {
        park(error.slotKey, job);
      } else if (error?.code === "invalidated") {
        onInvalidated();
      } else if (error?.fatal) {
        halt(error);
      } else if (TRANSIENT_CODES.has(error?.code)) {
        const delay = error.retryAfterMs || Math.min(MAX_BACKOFF_MS, 1000 * 2 ** job.attempts);
        pausedUntil = Math.max(pausedUntil, Date.now() + delay);
        log(`${error.message} Pausing ${Math.round(delay / 1000)}s.`);
        job.attempts += 1;
        if (job.attempts < MAX_ATTEMPTS) queue.push(job);
        else onResult(job.row, job.message, { skip: "error" });
        onChange();
      } else {
        log("translation failed:", error);
        onResult(job.row, job.message, { skip: "error" });
      }
    }

    function park(key, job) {
      const jobs = parked.get(key) || [];
      jobs.push(job);
      if (jobs.length > MAX_PARKED_PER_MODEL) {
        const dropped = jobs.shift();
        onResult(dropped.row, dropped.message, { skip: "dropped" });
      }
      parked.set(key, jobs);
      onChange();
    }

    /** Called when an on-device model changes state: retries the jobs that were waiting for it. */
    function resumeParked() {
      for (const [key, jobs] of parked) {
        const state = local.slotState(key);
        if (state === "needs-gesture" || state === "creating") continue;
        parked.delete(key);
        queue.push(...jobs);
      }
      pump();
    }

    function halt(error) {
      halted = { code: error.code, message: error.message };
      log("translation halted:", error.message);
      for (const job of queue.splice(0)) onResult(job.row, job.message, { skip: "dropped" });
      for (const jobs of parked.values()) for (const job of jobs) onResult(job.row, job.message, { skip: "dropped" });
      parked.clear();
      onChange();
    }

    /** After a settings change that may fix a fatal error (e.g. a new DeepL key). */
    function resume() {
      halted = null;
      fallbackBroken = false;
      cache.clear(); // Cached "can't translate" results may no longer hold.
      onChange();
      pump();
    }

    /** Forgets queued work; results of jobs still running are ignored. */
    function reset() {
      generation += 1;
      queue.length = 0;
      parked.clear();
      inflight.clear();
      halted = null;
      fallbackBroken = false;
      pausedUntil = 0;
      clearTimeout(resumeTimer);
      resumeTimer = 0;
      onChange();
    }

    function getStatus() {
      return {
        halted,
        paused: pausedUntil > Date.now(),
        queued: queue.length,
        parked: [...parked.values()].reduce((sum, jobs) => sum + jobs.length, 0),
        translated,
        fallbackBroken,
      };
    }

    function destroy() {
      reset();
      settings = null;
    }

    return { configure, enqueue, resumeParked, resume, reset, getStatus, destroy };
  }

  TCT.createPipeline = createPipeline;
})();
