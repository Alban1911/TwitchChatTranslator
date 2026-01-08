(() => {
  const STORAGE_AREA = "sync";
  const STORAGE_KEY = "enabled";

  const MESSAGE_ROW_SELECTOR =
    'div.chat-line__message[data-a-target="chat-line-message"]';
  const TEXT_FRAGMENT_SELECTOR = '[data-a-target="chat-message-text"]';

  // Twitch may reuse the same message row DOM nodes; a "seen node" set can
  // cause us to miss new messages. Track last text per row instead.
  const lastTextByRow = new WeakMap();
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

  function handleRow(row) {
    const text = extractText(row);
    if (!text) return;

    const prevText = lastTextByRow.get(row);
    if (prevText === text) return;
    lastTextByRow.set(row, text);

    // MVP behavior: just log the message text
    // (Later: send to background for translation and inject UI)
    // eslint-disable-next-line no-console
    console.log("[TCT]", text);
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


