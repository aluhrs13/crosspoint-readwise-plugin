# Plugin reference

Verified against the firmware source (`PluginCatalogActivity.cpp`,
`CrossPointWebServer.cpp`, `PluginHost.js.inc`). When in doubt, re-check the
firmware — these are hard limits, not conventions.

Updated for the firmware `develop` surface checked October 3, 2026. These
capabilities require matching firmware; no minimum released version is asserted.
Authoritative contracts: [endpoints](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/docs/webserver-endpoints.md)
and [events](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/docs/plugin-events.md).

## Browser `api` object (plugin.js)

`CrossPoint.registerPlugin(async (container, api) => { ... })` receives:

| Method | Returns | Notes |
|---|---|---|
| `api.relay(method, url, headers, body)` | `{status, headers, body}` | Device makes the HTTP(S) call (no CORS). **Response body capped at 32 KB.** Does NOT follow redirects — a 3xx comes back with its `Location` in `headers` (an array of `[name, value]` pairs, duplicates preserved). |
| `api.fetchToSd(url, dest, headers)` | `{status, bytes, complete, total, error?}` | Streams to `<dest>.part`, replacing the destination only after completion. Range resume in 2 MB segments; follows up to 5 redirects, forwarding headers only on the original origin. Clean up abandoned `.part` files. |
| `api.writeFile(path, dataB64)` | `{ok, bytes}` | Host decodes base64 into a multipart binary upload. Atomic replacement via `<path>.tmp`, cap 256 KB, non-empty body required. Absolute paths without `..`; credential stores refused. |
| `api.crypto(op, fields)` | op-specific | Base64 I/O. Ops: `random`, `sha1`, `sha256`, `aesenc`, `aesdec`, `keygen`, `pubencrypt`, `sign`, `rsadec`, `pkcs12`. Decryption leaves padding in place. See the endpoint contract for exact fields and key formats; failures return `{error}`. |
| `api.registerAction(name, fn)` | — | Exposes a headless action for POST `/api/plugin-jobs`. |
| `api.pluginFile(file)` | URL string | URL to another file in this plugin's folder. |
| `api.name` | string | Plugin name. |
| `api.dir` | string | Actual install directory. Keep config/cache files here, e.g. `api.dir + '/config.json'`; migrate older paths before removing them. |

Base64 helper for `writeFile` (btoa alone breaks on non-Latin1):

```js
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
```

## Same-origin endpoints (usable from any plugin page)

| Endpoint | Notes |
|---|---|
| `GET /download?path=<p>` | Read a file. Rejected only when the final path component starts with `.` — so `/.crosspoint/foo.json` works. |
| `GET /api/files?path=<p>` | JSON listing: `[{name, isDirectory, ...}]`. |
| `POST /upload?path=<dir>` | Multipart upload, streams to SD and overwrites existing names. Ensure the destination directory exists first. Stage EPUBs under a temporary name and rename only after completion. |
| `POST /mkdir` | Form params `name`, `path`. |
| `POST /move`, `/rename`, `/delete` | Form-encoded. `/delete` takes `path` (folders must be empty). Protected names (leading `.`) rejected for move/rename/delete. |
| `GET/POST /api/settings` | Reads/writes keyed settings. `dictionaryName` is an enum: GET returns its `options` and current index; POST `{dictionaryName: index}` applies immediately. Do not rewrite settings.json. |
| `GET /api/status?plugin=<name>` | Includes a stable per-device, per-plugin `deviceId` when NVS is available. |
| `POST /api/book-key` | `{path, key, expires?}` stores a 16-byte base64 book key in a device-wrapped `<book>.key` sidecar; expiry is authenticated. |

## device.json schema (firmware-interpreted, on-device screen)

**Hard cap: the whole file must be < 8 KB** (`MAX_MANIFEST_SIZE`).

```jsonc
{
  "title": "Shown in Settings > System > Plugins",
  "token":  { "file": "/.crosspoint/x.json", "path": "token" },   // optional auth token
  "config": { "file": "/.crosspoint/x.json" },                    // optional; flat JSON -> {cfg.KEY}
  "browse": {
    "format": "json",              // or "xml"
    "url": "https://...{page}...", // {page} substituted; NO server needed — static
                                   // paged files work (see dictionaries/catalog/)
    "method": "GET", "body": "", "headers": {},
    "items": "dotted.path",        // path to the item array ("" = root)
    "page_size": 8,                // max 16
    "fields": { "title": "t", "author": "a", "id": "i", "url": "u" },
    "lists": [                     // optional picker shown before browsing
      { "title": "First (uses browse.url)" },
      { "title": "Other", "url": "...", "body": "..." }
    ],
    "search": {                    // optional on-device search (JSON only)
      "url": "https://...?term={query}&page={page}",   // {query} = URL-encoded text
      "body": "{\"query\":\"{query_raw}\"}"            // {query_raw} = verbatim text
    }
  },
  "download": {
    // Single file:
    "url": "https://...{id}...", "dest_dir": "/Folder", "filename": "{title}.epub",
    "url_path": "dotted.path",     // optional extra API hop to resolve the URL
    // OR multi-file bundle (mutually exclusive in practice):
    "dest_dir": "/dictionaries",
    "bundle": { "base": "base", "files": "files", "subdir": "{id}" },
    "sidecar": { "path": "/.crosspoint/x_{md5}.json", "body": "..." }
  },
  "auth": { "type": "device_code" /* or "password" */, "request": {...}, "poll": {...} },
  "events": {                      // optional reader-lifecycle handlers, drained
    "reader.exit": {               // when the device is online (deferred delivery)
      "request": { "method": "POST", "url": "{cfg.server}/progress", "body": "..." },
      "toast": "Synced {event.book}"
    }
    // events: reader.open, reader.exit, reader.session, book.downloaded, sleep.enter.
    // Handler = "request" or "download" (+ optional "toast", "connect").
    // sleep.enter is delivered at sleep entry (WiFi brought up if needed);
    // failures stay queued and retry on the next drain (at-least-once).
    // Extra variables: {event.NAME}, {event.ts}, {meta.KEY} (book sidecar).
    // Full semantics + limits: firmware docs/plugin-events.md.
  }
}
```

Facts that matter:

- **Templating**: `{token}`, `{cfg.KEY}`, `{page}`, `{limit}` (= page_size+1),
  `{query}` / `{query_raw}` (active search text), `{id}`, `{title}`,
  `{author}`, `{url}`, `{md5}` and `{dest}` (sidecar only).
- Config and token file paths may be relative to the plugin's install folder.
  Config `dest_dir` overrides `download.dest_dir` after path validation.
- Book metadata lives at `{dest}.meta.json` as flat namespaced fields, e.g.
  `readwise_id`. It is available to events as `{meta.KEY}` and to KOSync when
  Send book metadata is enabled; the read cap is 2 KB.
- Event delivery is at-least-once and ordered per plugin; deduplicate using
  `{event.id}`. `reader.session` carries active seconds and progress in basis
  points. `connect: true` opts other handlers into sleep-time WiFi; sleep.enter
  opts in automatically. Limits: 8 subscribed plugins, 4 handlers per drain,
  4 KB outbox per plugin, 1 MB event downloads. Subscriptions rebuild at boot.
- **Search**: a `browse.search` block with `url` and/or `body` adds a search
  action to the browsing header — it opens the on-device keyboard and re-runs
  the browse with the search templates. `search.url`/`search.body` each fall
  back to the browse `url`/`body`, so a body-searching API needs only
  `search.body` (see `bookfusion/device.json`). Results page normally via
  `{page}`/`{limit}`, span the whole catalog (not the current list), and Back
  returns to the pre-search view. JSON browse only — and the SERVER does the
  matching, so a static file catalog (like `dictionaries/`) cannot offer it.
  Use `{query}` in URLs (percent-encoded, `/` included) and `{query_raw}`
  inside JSON body strings (substituted verbatim).
- **Paging is URL-driven**: the firmware substitutes `{page}` and reads at most
  `page_size + 1` items from the response; a full `page_size + 1` means "more
  pages". It does NOT slice a long array — static catalogs must be
  pre-paginated into one file per page, each holding page_size items plus one
  lookahead item.
- **Bundle downloads** fetch `base + file` for every entry in the item's
  `files` array into `dest_dir/<subdir>/`, creating dirs (mkdir is recursive)
  and rolling back on failure. This downloader **follows redirects** (GitHub
  release asset URLs work here, unlike `/api/fetch`).
- **No archive extraction** exists anywhere in firmware — never ship
  `.zip`/`.tar.*` to the device; host loose files.
- **XML browse** (`format: "xml"`): `item` = repeating element name; field
  selectors `elem`, `elem@attr`, `@attr`; optional folder navigation via
  `container_element`; `extensions` filter. Bundle is JSON-only.
- Browse response caps: 1 MB (JSON, streamed to SD temp); auth/url_path hops
  48 KB.

## Reader dictionary engine (for dictionary-adjacent plugins)

- Loads from `/dictionaries/<folder>/` (or `/.dictionaries/`): exactly one
  `.idx` stem per folder, plus `.dict` or `.dict.dz` (dictzip). `.ifo` and
  `.syn` optional.
- `.idx` must be **uncompressed** (`.idx.gz` rejected) and sorted by
  `asciiCaseCmp` (bytewise, ASCII tolower per byte). 64-bit offsets
  (`idxoffsetbits=64`) rejected. Headwords < 256 bytes; definitions capped at
  64 KB; dictzip chunk table ≤ 8192 chunks.
- Active dictionary is persisted as a folder name (≤ 31 chars). Change it
  live through `/api/settings` using the dictionary option index, or through
  the on-device Settings > Dictionary picker.
- `scripts/build-dictionaries.mjs` is the working example of generating
  StarDict files that satisfy all of this.

## Store catalog (catalog.json)

```json
{
  "name": "myplugin",
  "title": "My Plugin",
  "description": "One line.",
  "author": "Diirge",
  "version": "1.0.0",
  "base": "https://raw.githubusercontent.com/itsthisjustin/sd-plugins/main/myplugin/",
  "files": ["manifest.json", "device.json", "plugin.js", "README.md"]
}
```

`name`: lowercase/digits/`-`. `files` must list every file to install; the
store fetches `base + file` for each. Bump `version` on every change — the
store offers updates only when a valid catalog MAJOR.MINOR.PATCH is newer
than the installed manifest (or the installed version is absent/invalid).
