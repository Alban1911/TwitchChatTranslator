(() => {
  const STORAGE_AREA = "sync";
  const STORAGE_KEY = "enabled";

  const MESSAGE_ROW_SELECTOR =
    'div.chat-line__message[data-a-target="chat-line-message"]';
  const TEXT_FRAGMENT_SELECTOR = '[data-a-target="chat-message-text"]';
  const MESSAGE_BODY_SELECTOR = '[data-a-target="chat-line-message-body"]';
  const TRANSLATION_CLASS = "tct-translation";

  // Twitch may reuse the same message row DOM nodes; a "seen node" set can
  // cause us to miss new messages. Track last text per row instead.
  const lastTextByRow = new WeakMap();
  const lastTranslationByRow = new WeakMap();
  let observer = null;
  let observedRoot = null;
  let attachIntervalId = null;

  let enabled = true;

  function extractText(row) {
    const fragments = row.querySelectorAll(TEXT_FRAGMENT_SELECTOR);
    const text = Array.from(fragments)
      .map((n) => n.textContent || "")
      .join("")
      .trim();
    return text || null;
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

  function ensureTranslationEl(row) {
    // IMPORTANT: Twitch uses a <span> for the message body; inserting a <div>
    // inside a <span> is invalid HTML and can cause layout/clipping issues.
    // So we insert our translation element *after* the body span.
    const bodySpan = row.querySelector(MESSAGE_BODY_SELECTOR);
    let el = row.querySelector(`.${TRANSLATION_CLASS}`);
    if (!el) {
      el = document.createElement("div");
      el.className = TRANSLATION_CLASS;
      el.style.display = "block";
      el.style.fontSize = "12px";
      el.style.opacity = "0.8";
      el.style.marginTop = "2px";
      el.style.userSelect = "text";
      if (bodySpan?.insertAdjacentElement) {
        bodySpan.insertAdjacentElement("afterend", el);
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

  function handleRow(row) {
    const text = extractText(row);
    if (!text) return;

    const prevText = lastTextByRow.get(row);
    if (prevText === text) return;
    lastTextByRow.set(row, text);

    // eslint-disable-next-line no-console
    console.log("[TCT]", text);

    // Translate + inject under the message. If translator is disabled or fails,
    // we just skip injection (but keep extractor logs).
    translateText(text)
      .then((translated) => {
        const prev = lastTranslationByRow.get(row);
        if (prev === translated) return;
        lastTranslationByRow.set(row, translated);

        const scrollEl = findScrollContainer(row);
        const shouldPin = isNearBottom(scrollEl);

        const el = ensureTranslationEl(row);
        el.textContent = translated;

        // If the user is already at the bottom, keep the chat pinned so our
        // extra line doesn't end up under the input box.
        if (shouldPin) scrollToBottom(scrollEl);
      })
      .catch(() => {
        // Keep console clean by default. (If you want debug logs later, we can add a flag.)
      });
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
    // find any message row, then observe its parent (the message list container).
    const firstRow = document.querySelector(MESSAGE_ROW_SELECTOR);
    return (
      firstRow?.closest?.('[data-test-selector="chat-scrollable-area__message-container"]') ||
      firstRow?.parentElement ||
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
      // eslint-disable-next-line no-console
      console.log("[TCT] disabled");
      return;
    }

    startOrRestart();
    // eslint-disable-next-line no-console
    console.log("[TCT] enabled");
  }

  // Initial state
  chrome.storage[STORAGE_AREA].get({ [STORAGE_KEY]: true }, (res) => {
    setEnabled(res[STORAGE_KEY]);
  });

  // React to toggle changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== STORAGE_AREA) return;
    if (!changes[STORAGE_KEY]) return;
    setEnabled(changes[STORAGE_KEY].newValue);
  });
})();


