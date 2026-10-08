# Contributing to Twitch Chat Translator

Contributions are welcome! Here's how to get started.

## Setting up the development environment

1. Fork and clone the repository
2. Load the extension as described in the [README](README.md#installation): `chrome://extensions` → Developer mode → Load unpacked
3. Make your changes, then click **reload** on the extension card — Twitch tabs that are already open pick up the new version without being refreshed
4. Test on a live Twitch channel. In the extension's **Options…**, turn on **Log what the extension does**: every message then shows up in the Twitch tab's console as `[TCT] translated from …` or `[TCT] skipped (reason): …`

The extension is plain JavaScript with no build step and no framework.

## Project structure

```
manifest.json                 Extension manifest (Manifest V3)
src/
  shared/
    settings.js               Settings (chrome.storage), target languages, message types — loaded everywhere
  background/
    service-worker.js         DeepL requests, toolbar badge, settings migration, re-injection on update
    deepl.js                  DeepL client — header auth, request batching, error classification
  content/                    Content scripts on twitch.tv, loaded in this order:
    dom.js                    Chat DOM (Twitch and 7TV) — finding the chat, reading messages, showing translations
    local-engine.js           On-device engine — Chrome's Translator and LanguageDetector APIs
    deepl-engine.js           DeepL engine — sends messages to the service worker
    pipeline.js               Translation queue — cache, de-duplication, back-pressure, retries
    main.js                   Entry point — watches the chat, applies settings, reports status
  popup/
    popup.html / .js          Toolbar popup — toggle, engine, language, display mode, status
  options/
    options.html / .js        Options page — DeepL key and fallback, "Try it", debug logging
icon.png                      Extension icon
icon-display.jpg              Large version of the icon
docs/
  icon.png                    README images
  screenshot-chat.png
```

The files you'll touch most are **`src/content/dom.js`** — everything that depends on Twitch's markup — and **`src/content/main.js`**, which ties the rest together.

## How it works

1. **Finding the chat** — `main.js` checks once a second for the chat the user can actually see (`findChat()`) and watches it with a MutationObserver. Following the *visible* chat matters: 7TV hides Twitch's chat, which keeps running underneath, and draws its own; BetterTTV and FrankerFaceZ keep Twitch's markup. The same check follows Twitch's navigation between channels, which doesn't reload the page.
2. **Reading a message** — `readMessage()` splits a chat row into text to translate and parts to keep as they are: emotes, @mentions and links. Its `signature` identifies the content: re-renders, other extensions and hover effects leave it unchanged, so nothing is translated twice, while a deleted or edited message changes it and its stale translation goes away. Rows without enough text (emote-only, a lone Latin-script word like "gg", `!commands`) are ignored.
3. **Queue** — `pipeline.js` caches results, translates identical messages (spam, copy-pasta) once, holds at most 40 waiting messages and serves the newest first. Rate limits and network errors pause it with backoff; a fatal error (bad DeepL key, quota used up) stops it, with a notice on the page, until the settings change. Background tabs don't translate; they catch up when shown again.
4. **On-device engine** — `local-engine.js` detects each message's language with `LanguageDetector` and translates it with a `Translator` for that language pair. Chrome downloads each model on first use, and only lets a page start that download during a user gesture: until then the pair's messages wait, the notice asks for a click, and the next click or key press on the page creates the model. The text between emotes is translated piece by piece so emotes stay exactly in place.
5. **DeepL engine** — the content script sends the message to the service worker as XML, with emotes, mentions and links as `<x id="n"/>` tags. The worker batches messages from all tabs into one request and authenticates with the `Authorization: DeepL-Auth-Key` header. Messages the on-device detector is sure are already in the target language are never sent.
6. **Showing translations** — `renderTranslation()` adds a `.tct-translation` element after the message (after the whole row in VOD chat) or, in replace mode, hides the message and shows the translation in its place. It only writes to the page when something is missing or misplaced, so it runs again after every change to the row and undoes Twitch's re-renders. If the chat was scrolled to the newest message, it stays there.
7. **Updates** — when the extension is installed or updated, the service worker injects the content scripts into open Twitch tabs; the new copy takes over from the old one through a `tct:takeover` event.

State flow: settings live in `chrome.storage.sync` (the DeepL key in `chrome.storage.local`, never synced), and every part follows `chrome.storage.onChanged`. The popup asks the current tab's content script for its status (`tct:get-tab-status`); DeepL errors are kept in `chrome.storage.session` for the popup and the toolbar badge.

## Guidelines

- Keep it simple — plain JavaScript, no build step, no framework
- Test with Twitch's own chat and with 7TV, BetterTTV and FrankerFaceZ installed
- Test live, popout and VOD chat, and switching channels without a full page reload
- Turning the translator off must remove everything the extension added to the page
- Never translate on a mutation alone: Twitch re-renders constantly, so compare message signatures
- Put new Twitch selectors in `SEL` in `dom.js`, preferring `data-a-target` attributes over class names

## Reporting issues

If you find a bug or have a feature request, please [open an issue](https://github.com/Alban1911/TwitchChatTranslator/issues). A console log helps a lot: turn on **Log what the extension does** in Options, then press `F12` on the Twitch tab — extension logs are prefixed with `[TCT]`.
