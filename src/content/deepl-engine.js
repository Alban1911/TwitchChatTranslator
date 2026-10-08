// DeepL translation through the service worker, which holds the API key and batches requests.
(() => {
  const TCT = (globalThis.TCT = globalThis.TCT || {});

  const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
  const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const PLACEHOLDER = /<x\s+id\s*=\s*["']?(\d+)["']?\s*\/?>(?:\s*<\/x>)?/gi;

  function escapeXml(text) {
    return text.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
  }

  function unescapeXml(text) {
    return text
      .replace(/<\/?x\b[^>]*>/gi, "") // Stray placeholder fragments.
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
        if (name[0] !== "#") return XML_ENTITIES[name.toLowerCase()] ?? entity;
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      });
  }

  /** Message parts → DeepL XML: emotes, mentions and links become <x id="n"/> tags. */
  function toXml(parts) {
    let index = 0;
    return parts.map((part) => (part.type === "text" ? escapeXml(part.text) : `<x id="${index++}"/>`)).join("");
  }

  /** DeepL XML → segments: strings, or numbers pointing at the message's verbatim parts. */
  function fromXml(xml, verbatimCount) {
    const segments = [];
    let last = 0;
    for (const match of xml.matchAll(PLACEHOLDER)) {
      if (match.index > last) segments.push(unescapeXml(xml.slice(last, match.index)));
      const id = Number(match[1]);
      if (id < verbatimCount) segments.push(id);
      last = match.index + match[0].length;
    }
    if (last < xml.length) segments.push(unescapeXml(xml.slice(last)));
    return segments.filter((segment) => segment !== "");
  }

  function toError(plain) {
    const error = new Error(plain?.message || "DeepL request failed");
    error.code = plain?.code || "server";
    error.fatal = !!plain?.fatal;
    error.retryAfterMs = plain?.retryAfterMs || 0;
    return error;
  }

  function createDeeplEngine() {
    async function translate(message, targetLang) {
      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: TCT.MSG.DEEPL_TRANSLATE,
          text: toXml(message.parts),
          targetLang,
        });
      } catch (error) {
        // "Extension context invalidated": the extension was updated or removed under us.
        const invalidated = /context invalidated/i.test(String(error?.message));
        throw toError({ code: invalidated ? "invalidated" : "network", message: String(error?.message || error) });
      }
      if (!response?.ok) throw toError(response?.error);

      const sourceLang = response.result.detectedSourceLang || null;
      if (sourceLang && TCT.lang.same(sourceLang, targetLang)) return { skip: "same-language", sourceLang };
      return { segments: fromXml(response.result.text, message.verbatim.length), sourceLang };
    }

    return { translate };
  }

  TCT.createDeeplEngine = createDeeplEngine;
  TCT.deeplXml = Object.freeze({ toXml, fromXml }); // Exposed for tests.
})();
