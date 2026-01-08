# TwitchChatTranslator (Extractor MVP)

Chrome Extension (Manifest V3) that **extracts live Twitch chat message text** from `twitch.tv` and logs it in the page DevTools console while enabled.

## What it does (right now)
- Watches Twitch chat for new messages (handles Twitch DOM re-use / re-mounts).
- Prints each message text to the console as:
  - `[TCT] <message text>`
- Has a popup toggle to enable/disable the extractor.

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
- `content.js`: Twitch chat observer + text extraction + logging
- `popup.html` / `popup.js`: Enable/disable toggle stored in `chrome.storage.sync`

## Next steps
Add translation (background/service worker + provider + options page) and inject translated text into the chat UI.


