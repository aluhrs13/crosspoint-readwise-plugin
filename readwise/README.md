# Readwise Reader

One-click sync of your [Readwise Reader](https://readwise.io/read) read-it-later
articles to the SD card as EPUBs.

## Set up

Copy this folder to `/plugins/readwise/` on the SD card and reconnect to the
CrossPoint web UI. Requires the current SD-card plugin host with `api.dir`,
`api.writeFile`, `api.fetchToSd`, and `api.registerAction`. Older hosts show an
upgrade message. The implementation targets the firmware `develop` API checked
on October 3, 2026; no minimum released firmware version has been verified.

For store installs, add this fork's
[catalog](https://raw.githubusercontent.com/aluhrs13/crosspoint-readwise-plugin/main/catalog.json)
to Plugin Store. The upstream catalog does not include this plugin.

1. Get your access token at <https://readwise.io/access_token> (sign in first).
2. Open the CrossPoint web UI → **Settings**, find the **Readwise Reader** card.
3. Paste the token, press **Test** (should say "Token OK"), then **Save**.

**Test** checks Reader access using a one-document metadata request through
the same SD-backed download path as Sync. It does not download an EPUB or use
the device's `/api/relay` endpoint.

## Use

Press **Sync**. New articles from your enabled lists are downloaded, converted
to EPUB, and saved into `/Readwise/Later/`, `/Readwise/Shortlist/`, or
`/Readwise/Feed/` on the SD card. The plugin creates enabled list folders
before fetching articles. Read the EPUBs on the device like any other book.

Older downloads directly under `/Readwise/` stay in place. Sync checks both
the old folder and all three list folders to avoid duplicate downloads, even
if an article has since changed lists in Reader. Existing files are not moved.

- **Later** and **Shortlist** are on by default; **Feed** (unread items only)
  can be enabled too.
- **Max articles to try per list** caps new article attempts per list
  (default 10). Failed downloads and missing bodies count toward this limit;
  articles already installed do not. Later + Shortlist can each try 10 articles.
  Progress shows attempted, saved, failed, and skipped counts as sync runs.
  Press Sync again to retry failures and fetch more.
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
  (`config.json` inside the installed Readwise plugin folder). On first load,
  the plugin copies legacy `/.crosspoint/readwise-plugin.json` settings into
  that folder, then deletes the legacy file only after the copy succeeds.
  Press **Clear** to clear the current config and delete any legacy config.
  An empty current config takes precedence over legacy settings.
  This is separate from the native firmware integration's credentials. If you
  tried the earlier plugin prototype, enter and save your token again.
- There is no on-device browsing screen: the Reader API's cursor-based
  pagination and JSON-embedded article bodies don't fit the firmware's
  generic `device.json` catalog engine, so everything runs from the web page.

## Metadata and external sync

Each new EPUB gets a neighboring `.epub.meta.json` file:

```json
{"readwise_id":"<Reader document ID>","source":"readwise"}
```

Metadata is written before publishing the completed EPUB. If either step fails,
the article stays retryable. Existing EPUBs are left in place without backfilling
sidecars; delete an old EPUB and sync again to regenerate it with metadata.
The firmware makes these fields available to event handlers as
`{meta.readwise_id}` and to KOSync uploads when **Send book metadata** is enabled.
This plugin does not subscribe to events or send reading activity to Readwise.

External tools can enqueue the registered `sync` action:

```sh
curl -X POST http://crosspoint.local/api/plugin-jobs \
  -H 'Content-Type: application/json' \
  -d '{"plugin":"readwise","action":"sync"}'
curl 'http://crosspoint.local/api/plugin-jobs/status?id=<returned-id>'
```

Keep Settings or `http://crosspoint.local/plugins-run` open for execution.
Jobs use the saved config, not unsaved form edits, and return a small summary
with `added`, `failed`, `skipped`, and `limited` fields. Download failures fail
the job; details appear in the Settings card. Concurrent sync/test operations
are rejected. The job queue does not execute JavaScript while the browser is
closed, and the firmware event engine cannot perform HTML-to-EPUB conversion.

## Upstream baseline

This fork incorporates upstream `itsthisjustin/sd-plugins` through `389a89f`
(October 2, 2026) and preserves both repositories' Git histories. It includes
upstream's live dictionary settings, plugin-local config, semantic update
comparison, configurable WebDAV destinations, and catalog additions. The older
in-tree Protected Content plugin is replaced by upstream's externally hosted
catalog entry. Other upstream plugins' config-path changes do not migrate
their old credentials; configure those plugins again after upgrading.

API references: [plugin host](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/src/network/html/shared/PluginHost.js.inc),
[endpoints](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/docs/webserver-endpoints.md),
and [events](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/docs/plugin-events.md).
