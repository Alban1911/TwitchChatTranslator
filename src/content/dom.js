// Twitch chat DOM: finding the chat, reading messages and showing translations.
// Handles Twitch's own chat (live and VOD) and the 7TV extension's chat, which hides Twitch's
// chat and draws its own. BetterTTV and FrankerFaceZ keep Twitch's markup.
(() => {
  const TCT = (globalThis.TCT = globalThis.TCT || {});

  const LIVE_ROW = 'div.chat-line__message[data-a-target="chat-line-message"]';
  // VOD/replay rows. This class is more stable than the generated Layout-sc-* wrappers.
  const VOD_ROW = "div.video-chat__message";
  const SEVENTV_ROW = "div.seventv-message";

  const TRANSLATION_CLASS = "tct-translation";
  const HIDDEN_ATTR = "data-tct-hidden";
  const STYLE_ID = "tct-style";
  const TOAST_ID = "tct-toast";
  // Elements carrying this attribute don't count as consent for model downloads (see local-engine.js).
  const NO_GESTURE_ATTR = "data-tct-no-gesture";

  const SEL = Object.freeze({
    row: `${LIVE_ROW}, ${VOD_ROW}, ${SEVENTV_ROW}`,
    liveRow: LIVE_ROW,
    vodRow: VOD_ROW,
    sevenTvRow: SEVENTV_ROW,
    liveBody: '[data-a-target="chat-line-message-body"]',
    sevenTvBody: ".seventv-chat-message-body",
    textFragment: '[data-a-target="chat-message-text"], .text-fragment, .text-token',
    mention: '[data-a-target="chat-message-mention"], .mention-fragment, .mention-token',
    link: "a[href]",
    // 7TV wraps emotes (and zero-width emotes stacked on them) in a box; keep the whole box.
    emoteBox: ".seventv-emote-box",
    // Never read from these: tooltips (they contain extra text), usernames, badges, reply
    // headers, hover buttons, and anything we injected ourselves.
    skip: [
      ".bttv-tooltip",
      "[role='tooltip']",
      ".chat-line__username-container",
      ".chat-badge",
      "[data-a-target='chat-message-username']",
      ".video-chat__message-author",
      ".seventv-chat-user",
      ".seventv-reply-part",
      ".seventv-chat-message-buttons",
      `.${TRANSLATION_CLASS}`,
    ].join(", "),
    messageContainer: '[data-test-selector="chat-scrollable-area__message-container"]',
    scroller: '[data-a-target="chat-scroller"]',
  });

  const CSS = `
.${TRANSLATION_CLASS} {
  display: block;
  margin-top: 2px;
  font-size: 0.92em;
  opacity: 0.8;
  overflow-wrap: anywhere;
  user-select: text;
}
.${TRANSLATION_CLASS}[data-tct-mode="replace"] {
  display: inline;
  margin-top: 0;
  font-size: inherit;
  opacity: 1;
}
.${TRANSLATION_CLASS} img { vertical-align: middle; }
.tct-source-lang {
  display: inline-block;
  margin-right: 4px;
  padding: 0 3px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 0.75em;
  font-weight: 600;
  line-height: 1.35;
  opacity: 0.7;
  vertical-align: 1px;
}
[${HIDDEN_ATTR}] { display: none !important; }
#${TOAST_ID} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  box-sizing: border-box;
  max-width: min(380px, calc(100vw - 32px));
  padding: 10px 12px;
  border: 1px solid #3a3a3d;
  border-radius: 8px;
  background: #18181b;
  color: #efeff1;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
}
#${TOAST_ID} strong { display: block; margin-bottom: 2px; color: #bf94ff; font-weight: 600; }
#${TOAST_ID} button {
  flex: none;
  margin: -4px -6px 0 0;
  padding: 2px 6px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
}
#${TOAST_ID} button:hover { opacity: 1; }
`;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
  }

  function asElement(node) {
    return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement || null;
  }

  function closestRow(node) {
    return asElement(node)?.closest(SEL.row) || null;
  }

  /** True for our translation elements and the toast, and anything inside them. */
  function isOwnNode(node) {
    return !!asElement(node)?.closest(`.${TRANSLATION_CLASS}, #${TOAST_ID}`);
  }

  function isTranslationElement(node) {
    return node?.nodeType === Node.ELEMENT_NODE && node.classList.contains(TRANSLATION_CLASS);
  }

  /** Rendered by CSS (not display:none, visibility:hidden...), whether or not it's scrolled into view. */
  function isVisible(el) {
    if (!el?.isConnected) return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true });
    return el.getClientRects().length > 0;
  }

  // ---- Reading messages ---------------------------------------------------------

  /** The element holding the message itself (no username, badges or timestamp). */
  function getMessageBody(row) {
    if (row.matches(SEL.sevenTvRow)) return row.querySelector(SEL.sevenTvBody); // System notices have none.
    if (row.matches(SEL.liveRow)) {
      const body = row.querySelector(SEL.liveBody);
      if (body) return body;
    }
    // VOD rows, or a live layout we don't know yet: the closest element holding every text fragment.
    const fragments = Array.from(row.querySelectorAll(SEL.textFragment));
    if (!fragments.length) return null;
    let body = fragments[0].parentElement;
    while (body && body !== row && !fragments.every((fragment) => body.contains(fragment))) {
      body = body.parentElement;
    }
    return body;
  }

  function collectParts(node, parts, inText) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (inText) parts.push({ type: "text", text: child.data });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE || child.matches(SEL.skip)) continue;
      if (child.matches(SEL.emoteBox)) {
        const label = Array.from(child.querySelectorAll("img[alt]"), (img) => img.alt.trim()).filter(Boolean).join(" ");
        if (label) parts.push({ type: "emote", label, node: child.cloneNode(true) });
        continue;
      }
      if (child.tagName === "IMG") {
        const label = (child.getAttribute("alt") || "").trim();
        if (label && (child.getAttribute("src") || child.getAttribute("srcset"))) {
          parts.push({ type: "emote", label, node: child.cloneNode(false) });
        }
        continue;
      }
      if (child.matches(SEL.mention)) {
        parts.push({ type: "mention", label: child.textContent.trim(), node: child.cloneNode(true) });
        continue;
      }
      if (child.matches(SEL.link)) {
        parts.push({ type: "link", label: child.textContent.trim() || child.href, node: child.cloneNode(true) });
        continue;
      }
      collectParts(child, parts, inText || child.matches(SEL.textFragment));
    }
  }

  function normalizeParts(raw, isVod) {
    const parts = [];
    for (const part of raw) {
      const last = parts[parts.length - 1];
      if (part.type === "text" && last?.type === "text") last.text += part.text;
      else parts.push(part.type === "text" ? { type: "text", text: part.text } : part);
    }
    for (const part of parts) if (part.type === "text") part.text = part.text.replace(/\s+/g, " ");
    const first = parts[0];
    const last = parts[parts.length - 1];
    // VOD rows render the ": " separator inside the message container.
    if (first?.type === "text") first.text = (isVod ? first.text.replace(/^\s*:\s*/, "") : first.text).trimStart();
    if (last?.type === "text") last.text = last.text.trimEnd();
    return parts.filter((part) => part.type !== "text" || part.text);
  }

  function isTranslatable(text) {
    if (!/\p{L}/u.test(text) || /^!\S+$/.test(text)) return false; // "!commands" are for chat bots.
    // A lone Latin-script word is almost always a reaction or an emote name ("Clap", "KEKW", "gg").
    return /\s/.test(text) || /(?!\p{Script=Latin})\p{L}/u.test(text);
  }

  /**
   * Splits a chat row into translatable text and verbatim pieces (emotes, mentions, links).
   * Returns null when there's nothing worth translating.
   *
   * `signature` identifies the content: identical messages share translations, and a changed
   * signature means Twitch re-rendered the row with something else (e.g. "message deleted").
   */
  function readMessage(row) {
    const body = getMessageBody(row);
    if (!body) return null;
    const raw = [];
    collectParts(body, raw, body.matches(SEL.textFragment));
    const parts = normalizeParts(raw, row.matches(SEL.vodRow));
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!isTranslatable(text)) return null;
    return {
      parts,
      verbatim: parts.filter((part) => part.type !== "text"),
      text,
      signature: parts.map((part) => (part.type === "text" ? part.text : `\u001f${part.type}:${part.label}\u001f`)).join(""),
    };
  }

  // ---- Showing translations -----------------------------------------------------

  function fillTranslation(el, message, result, { mode, showSourceLang, targetLang }) {
    el.dataset.tctMode = mode;
    el.lang = targetLang;
    const sourceName = result.sourceLang ? TCT.lang.name(result.sourceLang) : "";
    el.title = mode === "replace" ? `Original: ${message.text}` : sourceName ? `Translated from ${sourceName}` : "";

    const content = document.createDocumentFragment();
    if (showSourceLang && result.sourceLang) {
      const tag = document.createElement("span");
      tag.className = "tct-source-lang";
      tag.textContent = TCT.lang.base(result.sourceLang).toUpperCase();
      content.append(tag);
    }
    const used = new Set();
    for (const segment of result.segments) {
      if (typeof segment === "string") content.append(segment);
      else if (message.verbatim[segment] && !used.has(segment)) {
        used.add(segment);
        content.append(message.verbatim[segment].node.cloneNode(true));
      }
    }
    // Never lose an emote, mention or link, even if the engine dropped its placeholder.
    message.verbatim.forEach((part, i) => {
      if (!used.has(i)) content.append(" ", part.node.cloneNode(true));
    });
    el.replaceChildren(content);
  }

  /**
   * Shows `result` on `row`, reusing `el` when given. Only writes to the DOM when something is
   * out of place, so it's cheap and safe to call again after every mutation of the row.
   * Returns the translation element.
   */
  function renderTranslation(row, message, result, el, options) {
    const original = getMessageBody(row);
    if (!original) return el;
    if (!el) {
      el = document.createElement("div");
      el.className = TRANSLATION_CLASS;
    }
    const key = `${options.mode}|${options.showSourceLang}|${message.signature}|${result.sourceLang}`;
    if (el.dataset.tctKey !== key) {
      fillTranslation(el, message, result, options);
      el.dataset.tctKey = key;
    }
    // Live rows: right after the message body (a <span>, so we can't go inside it).
    // VOD rows: after the whole row, unless we're replacing the text in place.
    const anchor = options.mode === "under" && row.matches(SEL.vodRow) ? row : original;
    if (anchor.nextElementSibling !== el) anchor.after(el);
    if (options.mode === "replace") {
      if (!original.hasAttribute(HIDDEN_ATTR)) original.setAttribute(HIDDEN_ATTR, "");
    } else if (original.hasAttribute(HIDDEN_ATTR)) {
      original.removeAttribute(HIDDEN_ATTR);
    }
    return el;
  }

  function removeTranslation(row, el) {
    el?.remove();
    const original = row.isConnected ? getMessageBody(row) : null;
    original?.removeAttribute(HIDDEN_ATTR);
  }

  /** Removes everything any copy of this extension injected, including older versions. */
  function removeAllInjected() {
    document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) => el.removeAttribute(HIDDEN_ATTR));
    // Versions before 0.3 hid originals with an inline style.
    document.querySelectorAll("[data-tct-replaced]").forEach((el) => {
      el.removeAttribute("data-tct-replaced");
      el.style.display = "";
    });
    document.getElementById(TOAST_ID)?.remove();
  }

  // ---- Finding the chat and keeping it scrolled ---------------------------------

  // Decided by CSS, not by current overflow: a fresh chat with few messages doesn't scroll yet.
  function findScroller(fromEl) {
    const known = fromEl.closest(SEL.scroller);
    if (known) return known;
    for (let el = fromEl.parentElement; el && el !== document.body; el = el.parentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return el;
    }
    return null;
  }

  /** The element to observe for new messages, and the scroll container to keep pinned. */
  function findChat() {
    const rows = document.querySelectorAll(SEL.row);
    if (!rows.length) return null;
    // Follow the chat the user can see: 7TV keeps Twitch's own chat in the page, hidden.
    const row = Array.prototype.find.call(rows, isVisible) || rows[0];
    const scroller = findScroller(row);
    return { root: scroller || row.closest(SEL.messageContainer) || row.parentElement, scroller };
  }

  function isNearBottom(scroller, thresholdPx = 16) {
    return scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight) <= thresholdPx;
  }

  function scrollToBottom(scroller) {
    scroller.scrollTop = scroller.scrollHeight;
  }

  // ---- Toast ----------------------------------------------------------------------

  /** Shows (or updates) the single notice in the corner of the page. */
  function showToast({ text, onDismiss = null }) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.setAttribute("role", "status");
      const body = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = "Twitch Chat Translator";
      const message = document.createElement("span");
      message.className = "tct-toast-text";
      body.append(title, message);
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.title = "Dismiss";
      close.setAttribute("aria-label", "Dismiss");
      close.setAttribute(NO_GESTURE_ATTR, "");
      toast.append(body, close);
      (document.body || document.documentElement).append(toast);
    }
    const message = toast.querySelector(".tct-toast-text");
    if (message.textContent !== text) message.textContent = text;
    const close = toast.querySelector("button");
    close.hidden = !onDismiss;
    close.onclick = onDismiss
      ? (event) => {
          event.stopPropagation();
          onDismiss();
        }
      : null;
  }

  function hideToast() {
    document.getElementById(TOAST_ID)?.remove();
  }

  TCT.dom = Object.freeze({
    SEL,
    NO_GESTURE_ATTR,
    ensureStyles,
    closestRow,
    isOwnNode,
    isTranslationElement,
    isVisible,
    readMessage,
    renderTranslation,
    removeTranslation,
    removeAllInjected,
    findChat,
    isNearBottom,
    scrollToBottom,
    showToast,
    hideToast,
  });
})();
