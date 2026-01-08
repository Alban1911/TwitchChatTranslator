# TwitchChatTranslator (DeepL Translator)

![Icon preview](icon-display.jpg)

Chrome Extension (Manifest V3) that **translates live Twitch chat messages** on `twitch.tv` using **DeepL** and injects the translation under each message.

## What it does
- Watches Twitch chat for new messages (handles Twitch DOM re-use / re-mounts).
- Translates each message via **DeepL** and injects a translated line under it.
- Still logs extracted message text as `[TCT] ...` in the console.
- Has a popup toggle to enable/disable the translator.

## Install (Load unpacked)
1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (the one containing `manifest.json`)

## Use
1. Open a Twitch channel page (`https://www.twitch.tv/<channel>`) or popout chat.
2. Click the extension icon.
3. Toggle **Enable extractor** ON.
4. Open the Twitch tab DevTools Console (F12) and look for:
   - `[TCT] enabled`
   - `[TCT] attached`
   - `[TCT] ...` (message logs)

To stop it, toggle OFF (you should see `[TCT] disabled`).

Tip: In the Console, filter for `[TCT]` to only see extractor logs.

## Files
- `manifest.json`: Extension manifest (MV3)
- `content.js`: Twitch chat observer + text extraction + translation injection
- `popup.html` / `popup.js`: Enable/disable toggle stored in `chrome.storage.sync`
- `options.html` / `options.js`: Configure DeepL (endpoint + API key) and target language
- `background.js`: DeepL translation + caching (service worker)

## Next steps
Add quality improvements (language autodetect tuning, better UI styling, rate limiting, and per-channel settings).


