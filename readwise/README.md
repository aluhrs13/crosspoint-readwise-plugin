# Readwise Reader

One-click sync of your [Readwise Reader](https://readwise.io/read) read-it-later
articles to the SD card as EPUBs.

## Set up

Copy this folder to `/plugins/readwise/` on the SD card and reconnect to the
CrossPoint web UI. Requires firmware with SD-card plugin support.

For store installs after this PR merges, add this fork's
[catalog](https://raw.githubusercontent.com/aluhrs13/crosspoint-readwise-plugin/main/catalog.json)
to Plugin Store. The upstream catalog does not include this plugin.

1. Get your access token at <https://readwise.io/access_token> (sign in first).
2. Open the CrossPoint web UI → **Settings**, find the **Readwise Reader** card.
3. Paste the token, press **Test** (should say "Token OK"), then **Save**.

## Use

Press **Sync**. New articles from your enabled lists are downloaded, converted
to EPUB, and saved to `/Readwise/` on the SD card — read them on the device
like any other book.

- **Later** and **Shortlist** are on by default; **Feed** (unread items only)
  can be enabled too.
- **Max new per list** caps how many new articles one Sync fetches per list
  (default 10) — press Sync again to fetch more.
- Articles already on the card are skipped. Delete an EPUB to re-download it
  on the next Sync.
- Keep the web page open until Sync finishes. Requests are paced to respect
  Readwise's rate limit; a rate-limited request waits 60 seconds and retries once.
- Missing article bodies are skipped and retried on the next Sync. A summary
  is never substituted for the full article.
- Each list scan stops after 15 pages (up to 750 entries). If the scan limit
  is reached, the report says so; older entries beyond this window are not fetched.

## Notes

- **Fully read-only**: the plugin never writes to your Readwise account —
  syncing does not mark articles opened, seen, or archived.
- **Text-only**: images are replaced with their alt text or removed. PDFs,
  uploaded EPUBs, videos, and highlights/notes are skipped.
- The access token is stored in plain text on the SD card
  (`/.crosspoint/readwise-plugin.json`). Press **Clear** to remove it.
  This is separate from the native firmware integration's credentials. If you
  tried the earlier plugin prototype, enter and save your token again.
- There is no on-device browsing screen: the Reader API's cursor-based
  pagination and JSON-embedded article bodies don't fit the firmware's
  generic `device.json` catalog engine, so everything runs from the web page.
