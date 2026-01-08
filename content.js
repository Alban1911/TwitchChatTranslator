(() => {
  const STORAGE_AREA = "sync";
  const STORAGE_KEY = "enabled";
  const DISPLAY_MODE_KEY = "displayMode"; // "under" | "replace"

  // Live chat message rows vs VOD/replay chat message containers have different wrappers.
  const LIVE_MESSAGE_ROW_SELECTOR =
    'div.chat-line__message[data-a-target="chat-line-message"]';
  // On VOD/replays the message text is typically inside `div.video-chat__message`.
  // This class is more stable than the random Layout-sc-* wrappers.
  const VOD_MESSAGE_ROW_SELECTOR = "div.video-chat__message";
  const MESSAGE_ROW_SELECTOR = `${LIVE_MESSAGE_ROW_SELECTOR}, ${VOD_MESSAGE_ROW_SELECTOR}`;

  const TEXT_FRAGMENT_SELECTOR = '[data-a-target="chat-message-text"]';
  const MESSAGE_BODY_SELECTOR = '[data-a-target="chat-line-message-body"]';
  const TRANSLATION_CLASS = "tct-translation";
  const REPLACED_ATTR = "data-tct-replaced";

  // Twitch may reuse the same message row DOM nodes; a "seen node" set can
  // cause us to miss new messages. Track last text per row instead.
  let lastTextByRow = new WeakMap();
  let lastTranslationByRow = new WeakMap();
  // Track which *source* text we have successfully translated for this row.
  let lastSourceTextTranslatedByRow = new WeakMap();
  // Avoid duplicate in-flight translations for the same row/text.
  let inFlightSourceTextByRow = new WeakMap();

  // Throttle translations to avoid burst rate limits when translating a backlog.
  const TRANSLATE_CONCURRENCY = 2;
  const TRANSLATE_DELAY_MS = 50;
  const translateQueue = [];
  let translateActive = 0;
  let observer = null;
  let observedRoot = null;
  let attachIntervalId = null;

  let enabled = true;
  let displayMode = "under";

  function isInOurTranslationEl(node) {
    return !!node?.closest?.(`.${TRANSLATION_CLASS}`);
  }

  function isInEmoteButton(node) {
    return (
      !!node?.closest?.('[data-test-selector="emote-button"]') ||
      !!node?.closest?.(".chat-line__message--emote-button")
    );
  }

  function isInsideBttvTooltip(node) {
    return !!node?.closest?.(".bttv-tooltip");
  }

  function getMessageTextElements(row) {
    // NOTE: We must NOT traverse the whole chat line container because:
    // - Twitch includes an "emote button" element inside the message body.
    // - BTTV includes tooltip DOM that contains extra text ("Chaîne ...").
    // - We inject our own translation element.
    return Array.from(row.querySelectorAll(TEXT_FRAGMENT_SELECTOR)).filter(
      (el) => !isInOurTranslationEl(el) && !isInEmoteButton(el)
    );
  }

  function buildTranslationPayload(row) {
    const textEls = getMessageTextElements(row);
    if (!textEls.length) return null;

    let out = "";
    const emotes = new Map(); // token -> { alt, src, srcset, className }
    let i = 0;

    const walk = (node) => {
      if (!node) return;

      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent || "";
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = /** @type {HTMLElement} */ (node);

      // Skip BTTV tooltip content entirely (it contains text we don't want to translate).
      if (el.classList?.contains("bttv-tooltip") || isInsideBttvTooltip(el)) return;

      if (el.tagName === "IMG") {
        const alt = el.getAttribute("alt") || "";
        const src = el.getAttribute("src") || "";
        const srcset = el.getAttribute("srcset") || "";
        const className = el.getAttribute("class") || "";

        // Only treat as an emote if it has an alt (emote code) and some src.
        if (alt && src) {
          const token = `__TCT_EMOTE_${i}__`;
          i += 1;
          emotes.set(token, { alt, src, srcset, className });
          out += ` ${token} `;
        }
        return;
      }

      for (const child of Array.from(el.childNodes)) walk(child);
    };

    for (const el of textEls) walk(el);

    let sourceText = out.replace(/\s+/g, " ").trim();
    // VOD messages often include a leading ":" span inside the container.
    sourceText = sourceText.replace(/^:\s*/, "");
    if (!sourceText) return null;

    // For translation we send placeholders, but for cache/identity we also use the same
    // placeholderized string (stable and avoids timing issues with emote rendering).
    return {
      sourceText,
      toTranslate: sourceText,
      emotes,
    };
  }

  function extractText(row) {
    return buildTranslationPayload(row)?.sourceText || null;
  }

  function renderTranslated(el, translatedText, emotes) {
    // Render translated text with emote placeholders replaced by <img> elements cloned
    // from the original message's emote images.
    el.textContent = "";
    if (!translatedText) return;

    const re = /__TCT_EMOTE_\d+__/g;
    let lastIndex = 0;
    let match = null;

    while ((match = re.exec(translatedText))) {
      const token = match[0];
      const before = translatedText.slice(lastIndex, match.index);
      if (before) el.appendChild(document.createTextNode(before));

      const meta = emotes?.get?.(token);
      if (meta) {
        const img = document.createElement("img");
        img.setAttribute("alt", meta.alt);
        if (meta.className) img.setAttribute("class", meta.className);
        if (meta.src) img.setAttribute("src", meta.src);
        if (meta.srcset) img.setAttribute("srcset", meta.srcset);
        img.setAttribute("loading", "lazy");
        el.appendChild(img);
      } else {
        // If we can't resolve the token, leave it as text.
        el.appendChild(document.createTextNode(token));
      }

      lastIndex = match.index + token.length;
    }

    const after = translatedText.slice(lastIndex);
    if (after) el.appendChild(document.createTextNode(after));
  }

  function findScrollContainer(fromEl) {
    let el = fromEl?.parentElement || null;
    while (el) {
      // Fast path: only consider elements that can actually scroll.
      if (el.scrollHeight > el.clientHeight + 2) {
        const style = window.getComputedStyle(el);
        const oy = style?.overflowY;
        if (oy === "auto" || oy === "scroll") return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function isNearBottom(scrollEl, thresholdPx = 8) {
    if (!scrollEl) return false;
    const distance =
      scrollEl.scrollHeight - (scrollEl.scrollTop + scrollEl.clientHeight);
    return distance <= thresholdPx;
  }

  function scrollToBottom(scrollEl) {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function getAnchor(row) {
    return row.matches?.(VOD_MESSAGE_ROW_SELECTOR)
      ? row
      : row.querySelector(MESSAGE_BODY_SELECTOR);
  }

  function getOriginalTextContainer(row) {
    // This is the element we hide in "replace" mode.
    // - Live: message body span
    // - VOD: the parent wrapper span containing the chat-message-text fragments
    if (row.matches?.(VOD_MESSAGE_ROW_SELECTOR)) {
      const frag = row.querySelector(TEXT_FRAGMENT_SELECTOR);
      return frag?.parentElement || frag || null;
    }
    return row.querySelector(MESSAGE_BODY_SELECTOR);
  }

  function applyDisplayMode(row, translationEl) {
    const originalEl = getOriginalTextContainer(row);
    if (!originalEl) return;

    // Ensure the translation element is positioned correctly for the mode.
    const desiredAnchor = displayMode === "replace" ? originalEl : getAnchor(row);
    if (desiredAnchor?.insertAdjacentElement) {
      const alreadyPlaced =
        desiredAnchor.nextElementSibling === translationEl ||
        translationEl.previousElementSibling === desiredAnchor;
      if (!alreadyPlaced) desiredAnchor.insertAdjacentElement("afterend", translationEl);
    }

    if (displayMode === "replace") {
      // Hide the original message text, show translation in its place.
      if (!originalEl.hasAttribute(REPLACED_ATTR)) originalEl.setAttribute(REPLACED_ATTR, "1");
      originalEl.style.display = "none";

      translationEl.style.display = "inline";
      translationEl.style.fontSize = "";
      translationEl.style.opacity = "";
      translationEl.style.marginTop = "0";
    } else {
      // Default: show translation under original.
      originalEl.removeAttribute(REPLACED_ATTR);
      originalEl.style.display = "";

      translationEl.style.display = "block";
      translationEl.style.fontSize = "12px";
      translationEl.style.opacity = "0.8";
      translationEl.style.marginTop = "2px";
    }
  }

  function cleanupInjected() {
    // Restore any hidden originals and remove injected translations.
    document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`[${REPLACED_ATTR}]`).forEach((el) => {
      el.removeAttribute(REPLACED_ATTR);
      el.style.display = "";
    });

    // Reset caches so enabling reprocesses currently rendered messages.
    lastTextByRow = new WeakMap();
    lastTranslationByRow = new WeakMap();
    lastSourceTextTranslatedByRow = new WeakMap();
    inFlightSourceTextByRow = new WeakMap();
    translateQueue.length = 0;
    translateActive = 0;
  }

  function ensureTranslationEl(row) {
    // IMPORTANT:
    // - Live chat uses a <span> for the message body; inserting a <div> inside a
    //   <span> is invalid HTML and can cause layout/clipping issues.
    // - VOD/replay chat uses `div.video-chat__message` as the message container.
    // So we always insert our translation element *after* the message container.
    const anchor = getAnchor(row);

    // Keep at most one translation element per message container.
    let el = row.querySelector(`.${TRANSLATION_CLASS}`);
    if (!el) {
      el = document.createElement("div");
      el.className = TRANSLATION_CLASS;
      el.style.display = "block";
      // Mode-specific styling is applied in applyDisplayMode().
      el.style.userSelect = "text";
      if (anchor?.insertAdjacentElement) {
        anchor.insertAdjacentElement("afterend", el);
      } else {
        row.appendChild(el);
      }
    }
    return el;
  }

  async function translateText(text) {
    const res = await chrome.runtime.sendMessage({ type: "TRANSLATE", text });
    if (!res?.ok) throw new Error(res?.error || "Translate failed");
    return res.translatedText;
  }

  function enqueueTranslation(row, payload) {
    if (!enabled) return;
    if (!row || !payload?.sourceText || !payload?.toTranslate) return;
    const sourceText = payload.sourceText;

    // Avoid duplicating in-flight translation for this row/text.
    if (inFlightSourceTextByRow.get(row) === sourceText) return;

    // If we already successfully translated this exact text for this row, skip.
    if (lastSourceTextTranslatedByRow.get(row) === sourceText) return;

    inFlightSourceTextByRow.set(row, sourceText);
    translateQueue.push({
      row,
      sourceText,
      toTranslate: payload.toTranslate,
      emotes: payload.emotes || new Map(),
      attempts: 0,
    });
    pumpTranslateQueue();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function pumpTranslateQueue() {
    if (!enabled) return;
    if (translateActive >= TRANSLATE_CONCURRENCY) return;
    if (!translateQueue.length) return;

    const job = translateQueue.shift();
    if (!job) return;
    translateActive += 1;

    try {
      const { row, sourceText, toTranslate, emotes } = job;

      if (!row.isConnected) return;
      if (extractText(row) !== sourceText) return;

      const translated = await translateText(toTranslate);

      lastSourceTextTranslatedByRow.set(row, sourceText);
      lastTranslationByRow.set(row, translated);

      const scrollEl = findScrollContainer(row);
      const shouldPin = isNearBottom(scrollEl);

      const el = ensureTranslationEl(row);
      renderTranslated(el, translated, emotes);
      applyDisplayMode(row, el);

      if (shouldPin) scrollToBottom(scrollEl);
    } catch (e) {
      job.attempts += 1;
      if (job.attempts <= 2 && enabled) {
        // Backoff for transient errors/rate limits.
        await sleep(800 * job.attempts);
        // Clear inflight marker so it can be re-enqueued.
        if (inFlightSourceTextByRow.get(job.row) === job.sourceText) {
          inFlightSourceTextByRow.delete(job.row);
        }
        enqueueTranslation(job.row, {
          sourceText: job.sourceText,
          toTranslate: job.toTranslate,
          emotes: job.emotes,
        });
      }
    } finally {
      if (inFlightSourceTextByRow.get(job.row) === job.sourceText) {
        inFlightSourceTextByRow.delete(job.row);
      }
      translateActive -= 1;
      await sleep(TRANSLATE_DELAY_MS);
      pumpTranslateQueue();
    }
  }

  function handleRow(row) {
    const payload = buildTranslationPayload(row);
    if (!payload?.sourceText) return;
    const text = payload.sourceText;

    const prevText = lastTextByRow.get(row);
    // If we already translated this exact text for this row, we can skip.
    // Otherwise, even if the row was "seen" earlier, we still want to translate it.
    if (prevText === text && lastSourceTextTranslatedByRow.get(row) === text) return;
    lastTextByRow.set(row, text);

    // eslint-disable-next-line no-console
    console.log("[TCT]", text);

    enqueueTranslation(row, payload);
  }

  function closestMessageRow(fromNode) {
    const el =
      fromNode instanceof HTMLElement
        ? fromNode
        : fromNode?.parentElement instanceof HTMLElement
          ? fromNode.parentElement
          : null;
    return el?.closest?.(MESSAGE_ROW_SELECTOR) || null;
  }

  function handleAddedNode(node) {
    // If a whole subtree is added, find all message rows inside it.
    if (node instanceof HTMLElement) {
      if (node.matches?.(MESSAGE_ROW_SELECTOR)) handleRow(node);
      const rows = node.querySelectorAll?.(MESSAGE_ROW_SELECTOR);
      if (rows?.length) rows.forEach(handleRow);
      return;
    }

    // If Twitch reuses nodes, text updates can come through as Text mutations.
    const row = closestMessageRow(node);
    if (row) handleRow(row);
  }

  function findObservedRoot() {
    // Twitch is a SPA; the chat list can re-mount. A robust heuristic is:
    // find any message row, then observe a stable container above it.
    const firstRow = document.querySelector(MESSAGE_ROW_SELECTOR);
    if (!firstRow) return null;

    // Prefer the scroll container if we can find it (works for both live and VOD layouts).
    const scrollEl = findScrollContainer(firstRow);
    if (scrollEl) return scrollEl;

    // Live chat often has this data-test-selector.
    return (
      firstRow.closest?.('[data-test-selector="chat-scrollable-area__message-container"]') ||
      firstRow.parentElement ||
      null
    );
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
    observedRoot = null;
    if (attachIntervalId) clearInterval(attachIntervalId);
    attachIntervalId = null;
  }

  function tryAttachObserver() {
    if (!enabled) return;

    const root = findObservedRoot();
    if (!root) return;
    if (root === observedRoot) return;

    if (observer) observer.disconnect();
    observedRoot = root;

    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "characterData") {
          // Text content changed; the row element may be reused.
          handleAddedNode(m.target);
          continue;
        }

        for (const n of m.addedNodes) handleAddedNode(n);
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Capture existing messages once on attach (useful on initial load).
    document.querySelectorAll(MESSAGE_ROW_SELECTOR).forEach(handleRow);

    // eslint-disable-next-line no-console
    console.log("[TCT] attached");
  }

  function startOrRestart() {
    if (attachIntervalId) clearInterval(attachIntervalId);
    attachIntervalId = setInterval(tryAttachObserver, 1000);
    tryAttachObserver();
  }

  function setEnabled(nextEnabled) {
    enabled = !!nextEnabled;
    if (!enabled) {
      stopObserver();
      cleanupInjected();
      // eslint-disable-next-line no-console
      console.log("[TCT] disabled");
      return;
    }

    startOrRestart();
    // After enabling, also translate any messages already rendered.
    // (This will be throttled by the queue.)
    document.querySelectorAll(MESSAGE_ROW_SELECTOR).forEach(handleRow);
    // eslint-disable-next-line no-console
    console.log("[TCT] enabled");
  }

  // Initial state
  chrome.storage[STORAGE_AREA].get(
    { [STORAGE_KEY]: false, [DISPLAY_MODE_KEY]: "under" },
    (res) => {
      displayMode = res[DISPLAY_MODE_KEY] || "under";
      setEnabled(res[STORAGE_KEY]);
    }
  );

  function setDisplayMode(nextMode) {
    displayMode = nextMode === "replace" ? "replace" : "under";

    // Re-apply mode to currently translated messages.
    document.querySelectorAll(MESSAGE_ROW_SELECTOR).forEach((row) => {
      const translated = lastTranslationByRow.get(row);
      if (!translated) return;
      const el = ensureTranslationEl(row);
      el.textContent = translated;
      applyDisplayMode(row, el);
    });
  }

  // React to toggle changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== STORAGE_AREA) return;
    if (changes[DISPLAY_MODE_KEY]) {
      setDisplayMode(changes[DISPLAY_MODE_KEY].newValue);
    }
    if (changes[STORAGE_KEY]) {
      setEnabled(changes[STORAGE_KEY].newValue);
    }
  });
})();


