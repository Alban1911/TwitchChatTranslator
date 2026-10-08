// Content-script entry point: watches Twitch chat and ties settings, DOM and translation together.
(() => {
  const TCT = globalThis.TCT;
  const { dom } = TCT;

  const POLL_MS = 1000; // Re-find the chat after Twitch's SPA navigations and re-renders.
  const SETTLE_MS = 120; // Let Twitch/BTTV/FFZ finish rendering a message before reading it.

  // ---- One instance per page ---------------------------------------------------
  // After the extension updates, the old content script keeps running ("orphaned") next to the
  // newly injected one. The newest instance takes over; older ones shut down when they see it.
  const INSTANCE_ATTR = "data-tct-instance";
  const TAKEOVER_EVENT = "tct:takeover";
  const instanceId = crypto.randomUUID();
  document.documentElement.setAttribute(INSTANCE_ATTR, instanceId);
  document.dispatchEvent(new Event(TAKEOVER_EVENT));
  document.addEventListener(TAKEOVER_EVENT, onTakeover);

  let settings = null;
  let running = false;
  let dead = false;
  let local = null;
  let deepl = null;
  let pipeline = null;
  let root = null;
  let scroller = null;
  let observer = null;
  let pollTimer = 0;
  let settleTimer = 0;
  let renderScheduled = false;
  let lastHref = location.href;
  let unsubscribeSettings = null;
  let dismissedToast = "";

  /** row → { signature, message, result, el, status: "pending" | "deferred" | "dropped" | "skipped" | "done" } */
  let rowStates = new WeakMap();
  const renderedRows = new Set(); // Rows that currently have a translation element.
  const dirtyRows = new Set();
  const rowsToRender = new Set();

  function log(...args) {
    if (settings?.debug) console.log("[TCT]", ...args);
  }

  function contextAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function onTakeover() {
    if (document.documentElement.getAttribute(INSTANCE_ATTR) !== instanceId) shutdown("a newer copy took over");
  }

  // ---- Lifecycle --------------------------------------------------------------------

  async function boot() {
    dom.removeAllInjected(); // Leftovers from an older copy of the extension.
    try {
      settings = await TCT.settings.load({ secrets: false });
      if (dead) return;
      unsubscribeSettings = TCT.settings.subscribe(onSettingsChanged);
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
    } catch (error) {
      shutdown(error);
      return;
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    apply(null, []);
  }

  async function onSettingsChanged(keys) {
    if (dead) return;
    const previous = settings;
    try {
      settings = await TCT.settings.load({ secrets: false });
    } catch (error) {
      shutdown(error);
      return;
    }
    apply(previous, keys);
  }

  function apply(previous, keys) {
    dismissedToast = ""; // The user changed something; notices are relevant again.
    if (!settings.enabled) {
      stop();
      return;
    }
    if (!running) {
      start();
      return;
    }
    const changed = (key) => previous && previous[key] !== settings[key];
    pipeline.configure(settings);
    if (changed("engine") || changed("targetLang") || changed("deeplFallback")) {
      resetTranslations();
    } else if (keys.includes("deeplAuthKey")) {
      pipeline.resume();
      rescan();
    }
    if (changed("displayMode") || changed("showSourceLang")) {
      for (const row of renderedRows) scheduleRender(row);
    }
    updateToast();
  }

  function start() {
    running = true;
    dom.ensureStyles();
    local = TCT.createLocalEngine({ onChange: onLocalEngineChange, log });
    deepl = TCT.createDeeplEngine();
    pipeline = TCT.createPipeline({
      local,
      deepl,
      isCurrent: (row, message) => rowStates.get(row)?.signature === message.signature,
      onResult,
      onChange: updateToast,
      onInvalidated: () => shutdown("the extension was reloaded"),
      log,
    });
    pipeline.configure(settings);
    pollTimer = setInterval(tick, POLL_MS);
    tick();
    log(`started (${settings.engine} → ${settings.targetLang})`);
  }

  function stop() {
    if (!running) return;
    running = false;
    detach();
    clearInterval(pollTimer);
    clearTimeout(settleTimer);
    pollTimer = 0;
    settleTimer = 0;
    pipeline.destroy();
    local.destroy();
    pipeline = local = deepl = null;
    clearAllRows();
    dom.hideToast();
    log("stopped");
  }

  /** Permanent: the extension was reloaded/removed, or a newer copy took over. */
  function shutdown(reason) {
    if (dead) return;
    dead = true;
    stop();
    document.removeEventListener(TAKEOVER_EVENT, onTakeover);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    try {
      unsubscribeSettings?.();
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // The extension context is already gone.
    }
    log("shut down:", reason);
  }

  // ---- Watching the chat ------------------------------------------------------------

  function tick() {
    if (!contextAlive()) {
      shutdown("the extension was reloaded");
      return;
    }
    const navigated = location.href !== lastHref;
    lastHref = location.href;
    if (navigated) local.resetLanguageHistory();
    // Chat add-ons like 7TV load after the page and hide Twitch's chat: follow the visible one.
    if (navigated || !dom.isVisible(root) || !root.querySelector(dom.SEL.row)) attach();
    sweep();
  }

  function attach() {
    const chat = dom.findChat();
    if (!chat || chat.root === root) return; // No messages yet: keep what we have.
    if (root) clearAllRows(); // Translations in a chat we stop watching would never update.
    detach();
    root = chat.root;
    scroller = chat.scroller;
    observer = new MutationObserver(onMutations);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    log("watching chat", root);
    for (const row of root.querySelectorAll(dom.SEL.row)) dirtyRows.add(row);
    scheduleSettle();
  }

  function detach() {
    observer?.disconnect();
    observer = null;
    root = null;
    scroller = null;
    dirtyRows.clear();
  }

  function onMutations(mutations) {
    for (const mutation of mutations) {
      if (dom.isOwnNode(mutation.target)) continue;
      if (mutation.type === "childList") {
        const changed = [...mutation.addedNodes, ...mutation.removedNodes];
        if (changed.every(dom.isTranslationElement)) continue; // Our own insertions/removals.
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE || dom.isTranslationElement(node)) continue;
          if (node.matches(dom.SEL.row)) dirtyRows.add(node);
          else for (const row of node.querySelectorAll(dom.SEL.row)) dirtyRows.add(row);
        }
      }
      // Something changed inside a row: its text was edited, it was deleted by a moderator, an
      // add-on swapped words for emotes...
      const row = dom.closestRow(mutation.target);
      if (row) dirtyRows.add(row);
    }
    scheduleSettle();
  }

  function scheduleSettle() {
    if (dirtyRows.size && !settleTimer) settleTimer = setTimeout(flushDirtyRows, SETTLE_MS);
  }

  function flushDirtyRows() {
    settleTimer = 0;
    if (!running) return;
    const rows = [...dirtyRows];
    dirtyRows.clear();
    for (const row of rows) processRow(row);
  }

  function processRow(row) {
    if (!row.isConnected) return;
    const message = dom.readMessage(row);
    const state = rowStates.get(row);
    if (state && message && state.signature === message.signature) {
      // Same content. Twitch may still have re-rendered around our element; put it back if needed.
      if (state.result) scheduleRender(row);
      return;
    }
    if (state) clearRow(row);
    if (!message) return; // Emote-only, deleted, or nothing to translate.
    const fresh = { signature: message.signature, message, result: null, el: null, status: "deferred" };
    rowStates.set(row, fresh);
    // Hidden tabs don't translate (saves CPU and DeepL quota); they catch up when shown again.
    if (!document.hidden) fresh.status = pipeline.enqueue(row, message) ? "pending" : "dropped";
  }

  /** Re-queues rows that were skipped while the tab was hidden or translation was halted. */
  function rescan() {
    if (!running || !root) return;
    for (const row of root.querySelectorAll(dom.SEL.row)) {
      const state = rowStates.get(row);
      if (!state) dirtyRows.add(row);
      else if (state.status === "deferred" || state.status === "dropped") {
        state.status = pipeline.enqueue(row, state.message) ? "pending" : "dropped";
      }
    }
    scheduleSettle();
  }

  function onVisibilityChange() {
    if (!document.hidden) rescan();
  }

  /** Drops state for rows Twitch removed from the page. */
  function sweep() {
    for (const row of renderedRows) {
      if (row.isConnected) continue;
      rowStates.get(row)?.el?.remove(); // VOD translations sit next to the row, not inside it.
      rowStates.delete(row);
      renderedRows.delete(row);
    }
  }

  // ---- Showing results --------------------------------------------------------------

  function onResult(row, message, result) {
    const state = rowStates.get(row);
    if (!state || state.signature !== message.signature) return;
    log(result.skip ? `skipped (${result.skip}):` : `translated from ${result.sourceLang}:`, message.text);
    if (result.skip) {
      state.status = result.skip === "dropped" ? "dropped" : "skipped";
      return;
    }
    state.result = result;
    state.status = "done";
    scheduleRender(row);
  }

  function scheduleRender(row) {
    rowsToRender.add(row);
    if (renderScheduled) return;
    renderScheduled = true;
    // Batch DOM writes per frame. Hidden tabs don't get animation frames.
    if (document.hidden) setTimeout(flushRenders, 0);
    else requestAnimationFrame(flushRenders);
  }

  function flushRenders() {
    renderScheduled = false;
    if (!running) {
      rowsToRender.clear();
      return;
    }
    // Twitch keeps chat scrolled to the newest message unless the user scrolled up. Our elements
    // make rows taller after the fact, so re-pin the chat if it was at the bottom before.
    const pin = !!scroller?.isConnected && dom.isNearBottom(scroller);
    const options = { mode: settings.displayMode, showSourceLang: settings.showSourceLang, targetLang: settings.targetLang };
    for (const row of rowsToRender) {
      const state = rowStates.get(row);
      if (!state?.result || !row.isConnected) continue;
      state.el = dom.renderTranslation(row, state.message, state.result, state.el, options);
      renderedRows.add(row);
    }
    rowsToRender.clear();
    if (pin) dom.scrollToBottom(scroller);
  }

  function clearRow(row) {
    const state = rowStates.get(row);
    if (state?.el) dom.removeTranslation(row, state.el);
    rowStates.delete(row);
    renderedRows.delete(row);
  }

  function clearAllRows() {
    for (const row of renderedRows) {
      const state = rowStates.get(row);
      if (state?.el) dom.removeTranslation(row, state.el);
    }
    renderedRows.clear();
    rowsToRender.clear();
    dirtyRows.clear();
    rowStates = new WeakMap();
  }

  /** Engine or language changed: drop every translation and start over with the visible chat. */
  function resetTranslations() {
    pipeline.reset();
    clearAllRows();
    if (root) {
      for (const row of root.querySelectorAll(dom.SEL.row)) dirtyRows.add(row);
      scheduleSettle();
    }
  }

  // ---- Status -------------------------------------------------------------------------

  function onLocalEngineChange() {
    pipeline?.resumeParked();
    updateToast();
  }

  function formatList(items) {
    return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }

  function updateToast() {
    if (!running || !pipeline || !local) {
      dom.hideToast();
      return;
    }
    const { halted } = pipeline.getStatus();
    const model = local.getStatus();
    let toast = null;
    if (halted) {
      toast = { id: `halted:${halted.code}`, text: halted.message };
    } else if (settings.engine === "local" && model.downloading.length) {
      const items = model.downloading.map(({ label, progress }) =>
        progress == null ? label : `${label} (${Math.round(progress * 100)}%)`
      );
      toast = { id: "downloading", text: `Downloading ${formatList(items)} for on-device translation…` };
    } else if (settings.engine === "local" && model.needsGesture.length) {
      toast = {
        id: "needs-gesture",
        text:
          `Chrome needs a one-time download for ${formatList(model.needsGesture)}. ` +
          "Click anywhere on the page to start it.",
        onDismiss: () => local.declinePending(),
      };
    }
    if (!toast || dismissedToast === toast.id) {
      dom.hideToast();
      return;
    }
    dom.showToast({
      text: toast.text,
      onDismiss: () => {
        if (toast.onDismiss) toast.onDismiss();
        else dismissedToast = toast.id;
        dom.hideToast();
      },
    });
  }

  function getStatus() {
    return {
      enabled: !!settings?.enabled,
      running,
      engine: settings?.engine,
      chatFound: !!root?.isConnected,
      local: local ? local.getStatus() : { supported: TCT.isLocalSupported(), needsGesture: [], downloading: [], failed: [] },
      pipeline: pipeline ? pipeline.getStatus() : null,
    };
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (message?.type !== TCT.MSG.GET_TAB_STATUS) return false;
    sendResponse(getStatus());
    return false;
  }

  boot();
})();
