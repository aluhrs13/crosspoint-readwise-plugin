// Readwise Reader sync for CrossPoint. One-click sync of Reader articles to
// the SD card as EPUBs, built entirely in the browser. There is no on-device
// screen (device.json): Reader's v3 API paginates with an opaque pageCursor
// and serves article content only as html_content inside JSON, neither of
// which the firmware's generic catalog engine can consume. Instead this card
// lists documents through the device (api.fetchToSd — bodies routinely exceed
// the 32 KB relay cap), converts the HTML to strict XHTML with DOMParser,
// packages a store-only EPUB 2 in plain JS, and uploads it to /Readwise/.
// Fully read-only: nothing is ever written to the Readwise account.
CrossPoint.registerPlugin(async (container, api) => {
  // Keep separate from the native firmware integration's credential format.
  const CONFIG_PATH = '/.crosspoint/readwise-plugin.json';
  const OUT_DIR = '/Readwise';
  const TMP_PREFIX = '/.crosspoint/readwise-tmp-';
  const LIST_URL = 'https://readwise.io/api/v3/list/';
  const AUTH_URL = 'https://readwise.io/api/v2/auth/';
  const LOCATIONS = ['later', 'shortlist', 'feed'];
  const PAGE_LIMIT = 50;
  const MAX_PAGES = 15;
  const DEFAULT_CAP = 10;
  const SKIP_CATEGORIES = ['pdf', 'epub', 'video', 'highlight', 'note'];

  container.innerHTML =
    '<h2>Readwise Reader</h2>' +
    '<p id="rw-status">Checking configuration…</p>' +
    '<div class="setting-row"><span class="setting-name">Access token</span>' +
    '<span class="setting-control"><input type="password" id="rw-token"></span></div>' +
    '<div class="setting-row"><span class="setting-name">Later</span>' +
    '<span class="setting-control"><input type="checkbox" id="rw-loc-later" checked></span></div>' +
    '<div class="setting-row"><span class="setting-name">Shortlist</span>' +
    '<span class="setting-control"><input type="checkbox" id="rw-loc-shortlist" checked></span></div>' +
    '<div class="setting-row"><span class="setting-name">Feed (unread only)</span>' +
    '<span class="setting-control"><input type="checkbox" id="rw-loc-feed"></span></div>' +
    '<div class="setting-row"><span class="setting-name">Max new per list</span>' +
    '<span class="setting-control"><input type="number" id="rw-cap" min="1" max="50" value="10"></span></div>' +
    '<div class="setting-row">' +
    '<button type="button" class="btn-small btn-add" id="rw-sync">Sync</button> ' +
    '<button type="button" class="btn-small" id="rw-save">Save</button> ' +
    '<button type="button" class="btn-small" id="rw-test">Test</button> ' +
    '<button type="button" class="btn-small" id="rw-clear" style="display:none">Clear</button>' +
    '</div>' +
    '<div id="rw-progress"></div>' +
    '<p style="color:#666">Get your access token at https://readwise.io/access_token. ' +
    'Sync converts new articles to text-only EPUBs in ' + OUT_DIR + '/ on the SD card. ' +
    'Fully read-only — nothing is ever written to your Readwise account. ' +
    'The token is stored in plain text on the SD card.</p>';

  const el = (id) => document.getElementById(id);
  const status = (t) => { el('rw-status').textContent = t; };
  const clearBtn = el('rw-clear');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let tmpCounter = 0;
  let nextRequestAt = 0;
  let busy = false;

  function b64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function xmlEscape(s) {
    return String(s == null ? '' : s)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF\uD800-\uDFFF]/gu, '')
      .replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  }

  function currentConfig() {
    const token = el('rw-token').value.trim();
    if (!token) throw new Error('access token is required');
    const cap = parseInt(el('rw-cap').value, 10);
    return {
      token,
      locations: {
        later: !!el('rw-loc-later').checked,
        shortlist: !!el('rw-loc-shortlist').checked,
        feed: !!el('rw-loc-feed').checked
      },
      cap: cap >= 1 && cap <= 50 ? cap : DEFAULT_CAP
    };
  }

  async function writeConfig(cfg) {
    const result = await api.writeFile(CONFIG_PATH, b64(JSON.stringify(cfg)));
    if (!result || !result.ok) throw new Error('could not save configuration to the SD card');
  }

  async function loadConfig() {
    try {
      const r = await fetch('/download?path=' + encodeURIComponent(CONFIG_PATH));
      if (!r.ok) return null;
      return JSON.parse(await r.text());
    } catch (e) {
      return null;
    }
  }

  async function postForm(path, fields) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    });
    if (!r.ok) throw new Error(path + ' failed (HTTP ' + r.status + ')');
  }

  function buildListUrl(location, cursor) {
    return LIST_URL + '?location=' + location + '&limit=' + PAGE_LIMIT +
      '&withHtmlContent=false' +
      (cursor ? '&pageCursor=' + encodeURIComponent(cursor) : '');
  }

  function buildBodyUrl(id) {
    return LIST_URL + '?id=' + encodeURIComponent(id) + '&withHtmlContent=true';
  }

  function isSyncable(doc, location) {
    if (!doc || typeof doc.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(doc.id)) return false;
    if (doc.parent_id) return false; // highlights/notes attached to a document
    if (SKIP_CATEGORIES.indexOf(doc.category) !== -1) return false;
    if (location === 'feed' && doc.first_opened_at != null) return false;
    return true;
  }

  function sanitizeTitle(title) {
    const cleaned = String(title || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9 ._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 60)
      .trim();
    return cleaned || 'Untitled';
  }

  // The device fetches the URL to a uniquely named temp file (unique so a
  // failed download can never be resumed-into by the next request — fetchToSd
  // resumes with Range segments), then the page reads it back over /download.
  // This is how responses larger than the 32 KB relay cap are handled.
  async function fetchJsonViaSd(url, token) {
    // Both metadata and article bodies share Reader's 20 requests/minute limit.
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextRequestAt = Date.now() + 3100;
    const tmp = TMP_PREFIX + Date.now().toString(36) + '-' + (tmpCounter++) + '.json';
    try {
      const res = await api.fetchToSd(url, tmp, { Authorization: 'Token ' + token });
      if (res.error || !res.status || res.status < 200 || res.status >= 300 || res.complete === false) {
        return { status: res.complete === false && res.status === 200 ? 0 : res.status || 0 };
      }
      const r = await fetch('/download?path=' + encodeURIComponent(tmp));
      if (!r.ok) return { status: 0 };
      return { status: res.status, json: JSON.parse(await r.text()) };
    } finally {
      await postForm('/delete', { path: tmp }).catch(() => {});
    }
  }

  async function fetchReaderJson(url, token) {
    let res = await fetchJsonViaSd(url, token);
    if (res.status === 429) {
      status('Readwise rate limit reached. Retrying in 60 seconds…');
      // fetchToSd does not expose Retry-After. Wait a full rate-limit window.
      await sleep(60000);
      res = await fetchJsonViaSd(url, token);
      status('Syncing…');
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error('Token rejected — check your access token.');
      err.auth = true;
      throw err;
    }
    if (res.status === 429) throw new Error('Readwise is still rate limited; try Sync again later');
    if (!res.json || !Array.isArray(res.json.results) ||
        (res.json.nextPageCursor != null && typeof res.json.nextPageCursor !== 'string')) {
      throw new Error('invalid or incomplete Reader response (HTTP ' + res.status + ')');
    }
    return res;
  }

  async function listInstalledIds() {
    const ids = new Set();
    const r = await fetch('/api/files?path=' + encodeURIComponent(OUT_DIR));
    if (r.status === 404) return ids; // first sync
    if (!r.ok) throw new Error('could not list installed articles (HTTP ' + r.status + ')');
    const list = JSON.parse(await r.text());
    if (!Array.isArray(list)) throw new Error('invalid SD directory listing');
    for (const f of list) {
      if (f.isDirectory || f.size === 0) continue;
      const m = /\[([A-Za-z0-9_-]+)\]\.epub$/.exec(f.name || '');
      if (m) ids.add(m[1]);
    }
    return ids;
  }

  function htmlToXhtml(html, doc) {
    const dp = new DOMParser();
    const src = dp.parseFromString(html, 'text/html');
    const body = src.body;

    const drop = body.querySelectorAll('script,style,iframe,svg,math,video,audio,form,' +
      'object,embed,canvas,noscript,link,meta,button,input,select,textarea');
    for (const n of Array.from(drop)) n.remove();

    for (const img of Array.from(body.querySelectorAll('img'))) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (alt) {
        const p = src.createElement('span');
        p.textContent = '[Image: ' + alt + ']';
        img.replaceWith(p);
      } else {
        img.remove();
      }
    }

    for (const n of Array.from(body.querySelectorAll('*'))) {
      // Prefixed elements (Word-paste <o:p> etc.) would serialize with an
      // unbound namespace and kill the device's strict XHTML parser.
      if (n.tagName.indexOf(':') !== -1) { n.replaceWith(...n.childNodes); continue; }
      for (const a of Array.from(n.getAttributeNames())) {
        if (!['href', 'id', 'title', 'lang', 'colspan', 'rowspan'].includes(a)) {
          n.removeAttribute(a);
        }
      }
      if (n.hasAttribute('href')) {
        const href = n.getAttribute('href');
        const resolved = safeUrl(href, doc.source_url || doc.url);
        if (href.startsWith('#')) continue;
        if (resolved) n.setAttribute('href', resolved);
        else n.removeAttribute('href');
      }
    }

    const title = doc.title || 'Untitled';
    const byline = [doc.author, doc.site_name].filter(Boolean).join(', ');
    const srcUrl = safeUrl(doc.source_url || doc.url || '');
    const shell = dp.parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + xmlEscape(title) +
      '</title></head><body>' +
      '<h1>' + xmlEscape(title) + '</h1>' +
      (byline ? '<p><em>' + xmlEscape(byline) + '</em></p>' : '') +
      (srcUrl ? '<p><a href="' + xmlEscape(srcUrl) + '">' + xmlEscape(srcUrl) + '</a></p>' : '') +
      '<hr/><div class="rw-content"></div></body></html>',
      'application/xml');
    const target = shell.getElementsByTagName('div')[0];
    for (const child of Array.from(body.childNodes)) {
      target.appendChild(shell.importNode(child, true));
    }
    // Strip control characters expat rejects; XMLSerializer passes them through.
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      new XMLSerializer().serializeToString(shell)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF\uD800-\uDFFF]/gu, '');
  }

  function safeUrl(value, base) {
    try {
      const url = new URL(value, base);
      return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : '';
    } catch (e) { return ''; }
  }

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Store-only zip avoids a runtime dependency. EPUB permits stored entries.
  function buildZip(entries) {
    const DOS_TIME = 0x0000;
    const DOS_DATE = 0x5a21; // 2025-01-01
    const enc = new TextEncoder();
    let size = 22;
    const metas = entries.map((e) => {
      const nameBytes = enc.encode(e.name);
      size += 30 + nameBytes.length + e.data.length + 46 + nameBytes.length;
      return { nameBytes, data: e.data, crc: crc32(e.data), offset: 0 };
    });
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let off = 0;
    for (const m of metas) {
      m.offset = off;
      dv.setUint32(off, 0x04034b50, true);
      dv.setUint16(off + 4, 10, true); // version needed
      dv.setUint16(off + 8, 0, true); // method: store
      dv.setUint16(off + 10, DOS_TIME, true);
      dv.setUint16(off + 12, DOS_DATE, true);
      dv.setUint32(off + 14, m.crc, true);
      dv.setUint32(off + 18, m.data.length, true);
      dv.setUint32(off + 22, m.data.length, true);
      dv.setUint16(off + 26, m.nameBytes.length, true);
      out.set(m.nameBytes, off + 30);
      out.set(m.data, off + 30 + m.nameBytes.length);
      off += 30 + m.nameBytes.length + m.data.length;
    }
    const cdStart = off;
    for (const m of metas) {
      dv.setUint32(off, 0x02014b50, true);
      dv.setUint16(off + 4, 20, true); // version made by
      dv.setUint16(off + 6, 10, true); // version needed
      dv.setUint16(off + 12, DOS_TIME, true);
      dv.setUint16(off + 14, DOS_DATE, true);
      dv.setUint32(off + 16, m.crc, true);
      dv.setUint32(off + 20, m.data.length, true);
      dv.setUint32(off + 24, m.data.length, true);
      dv.setUint16(off + 28, m.nameBytes.length, true);
      dv.setUint32(off + 42, m.offset, true);
      out.set(m.nameBytes, off + 46);
      off += 46 + m.nameBytes.length;
    }
    dv.setUint32(off, 0x06054b50, true);
    dv.setUint16(off + 8, metas.length, true);
    dv.setUint16(off + 10, metas.length, true);
    dv.setUint32(off + 12, off - cdStart, true);
    dv.setUint32(off + 16, cdStart, true);
    return out;
  }

  function buildEpub(doc, xhtml) {
    const title = doc.title || 'Untitled';
    const creator = doc.author || doc.site_name || 'Readwise';
    const uid = 'urn:readwise:' + doc.id;
    const date = typeof doc.published_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(doc.published_date)
      ? doc.published_date.slice(0, 10) : '';
    const containerXml = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
      '</rootfiles></container>';
    const opf = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:title>' + xmlEscape(title) + '</dc:title>' +
      '<dc:creator>' + xmlEscape(creator) + '</dc:creator>' +
      '<dc:language>' + xmlEscape(doc.language || 'und') + '</dc:language>' +
      '<dc:identifier id="bookid">' + xmlEscape(uid) + '</dc:identifier>' +
      (doc.source_url ? '<dc:source>' + xmlEscape(doc.source_url) + '</dc:source>' : '') +
      (date ? '<dc:date>' + xmlEscape(date) + '</dc:date>' : '') +
      '</metadata><manifest>' +
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
      '<item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>' +
      '</manifest><spine toc="ncx"><itemref idref="article"/></spine></package>';
    const ncx = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
      '<head><meta name="dtb:uid" content="' + xmlEscape(uid) + '"/>' +
      '<meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/>' +
      '<meta name="dtb:maxPageNumber" content="0"/></head>' +
      '<docTitle><text>' + xmlEscape(title) + '</text></docTitle>' +
      '<navMap><navPoint id="a1" playOrder="1"><navLabel><text>' + xmlEscape(title) +
      '</text></navLabel><content src="article.xhtml"/></navPoint></navMap></ncx>';
    const enc = new TextEncoder();
    return buildZip([
      { name: 'mimetype', data: enc.encode('application/epub+zip') },
      { name: 'META-INF/container.xml', data: enc.encode(containerXml) },
      { name: 'OEBPS/content.opf', data: enc.encode(opf) },
      { name: 'OEBPS/toc.ncx', data: enc.encode(ncx) },
      { name: 'OEBPS/article.xhtml', data: enc.encode(xhtml) }
    ]);
  }

  async function uploadEpub(filename, bytes) {
    // Publish only a completed upload; a partial .epub would be skipped forever.
    const tempName = 'readwise-upload-' + Date.now().toString(36) + '-' + (tmpCounter++) + '.tmp';
    const tempPath = OUT_DIR + '/' + tempName;
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'application/epub+zip' }), tempName);
    try {
      const r = await fetch('/upload?path=' + encodeURIComponent(OUT_DIR), { method: 'POST', body: fd });
      if (!r.ok) throw new Error('upload failed (HTTP ' + r.status + ')');
      await postForm('/rename', { path: tempPath, name: filename });
      return true;
    } finally {
      await postForm('/delete', { path: tempPath }).catch(() => {});
    }
  }

  // 'added' | 'exists' | 'nocontent'
  async function downloadArticle(doc, token) {
    const res = await fetchReaderJson(buildBodyUrl(doc.id), token);
    const full = res.json.results.find((item) => item && item.id === doc.id);
    if (!full) throw new Error('article no longer available');
    const html = full.html_content;
    if (typeof html !== 'string' || !html.trim()) return 'nocontent';
    const xhtml = htmlToXhtml(html, doc);
    const bytes = buildEpub(doc, xhtml);
    const filename = sanitizeTitle(doc.title) + ' [' + doc.id + '].epub';
    return (await uploadEpub(filename, bytes)) ? 'added' : 'exists';
  }

  async function syncLocation(location, cfg, installed, renderProgress) {
    const out = { location, added: 0, failed: 0, skipped: 0, failures: [], limited: false };
    let cursor = null;
    const cursors = new Set();
    for (let page = 0; page < MAX_PAGES && out.added < cfg.cap; page++) {
      let res;
      try {
        res = await fetchReaderJson(buildListUrl(location, cursor), cfg.token);
      } catch (e) {
        if (e.auth) throw e;
        out.failed++;
        out.failures.push('list failed: ' + e.message);
        return out;
      }
      for (const doc of res.json.results || []) {
        if (out.added >= cfg.cap) break;
        if (!isSyncable(doc, location) || installed.has(doc.id)) continue;
        renderProgress(location + ': ' + (out.added + 1) + '/' + cfg.cap + ' — ' +
          (doc.title || 'Untitled'));
        try {
          const result = await downloadArticle(doc, cfg.token);
          if (result === 'nocontent') { out.skipped++; continue; }
          installed.add(doc.id); // also dedups across locations in this sync
          if (result === 'added') out.added++;
        } catch (e) {
          if (e && e.auth) throw e;
          out.failed++;
          out.failures.push((doc.title || doc.id) + ': ' + e.message);
        }
      }
      cursor = res.json.nextPageCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) {
        out.failed++;
        out.failures.push('Reader repeated a page cursor; sync stopped');
        break;
      }
      cursors.add(cursor);
      if (page === MAX_PAGES - 1) out.limited = true;
    }
    return out;
  }

  function summaryLine(r) {
    if (!r.added && !r.failed && !r.skipped && !r.limited) return r.location + ': up to date';
    let s = r.location + ': ' + r.added + ' new';
    if (r.failed) s += ', ' + r.failed + ' failed';
    if (r.skipped) s += ', ' + r.skipped + ' skipped (no content)';
    if (r.limited) s += ', scan limit reached; older articles may remain';
    return s;
  }

  el('rw-sync').onclick = async () => {
    if (busy) return;
    let cfg;
    try {
      cfg = currentConfig();
      if (!LOCATIONS.some((loc) => cfg.locations[loc])) throw new Error('select at least one list');
    } catch (e) {
      status('Error: ' + e.message);
      return;
    }
    const syncBtn = el('rw-sync');
    busy = true;
    for (const id of ['rw-save', 'rw-clear', 'rw-test']) el(id).disabled = true;
    syncBtn.disabled = true;
    const report = [];
    const renderProgress = (current) => {
      el('rw-progress').innerHTML =
        report.concat(current ? [current] : []).map(escapeHtml).join('<br>');
    };
    status('Syncing…');
    renderProgress();
    try {
      const installed = await listInstalledIds();
      let totalNew = 0;
      let totalFailed = 0;
      for (const location of LOCATIONS) {
        if (!cfg.locations[location]) continue;
        const r = await syncLocation(location, cfg, installed, renderProgress);
        totalNew += r.added;
        totalFailed += r.failed;
        report.push(summaryLine(r));
        for (const f of r.failures) report.push('- ' + f);
        renderProgress();
      }
      status('Sync complete — ' + totalNew + ' new article' + (totalNew === 1 ? '' : 's') +
        (totalFailed ? ', ' + totalFailed + ' failed. See details below.' : '.'));
    } catch (e) {
      status(e && e.auth ? 'Token rejected — check your access token.' : 'Sync failed: ' + e.message);
    } finally {
      syncBtn.disabled = false;
      busy = false;
      for (const id of ['rw-save', 'rw-clear', 'rw-test']) el(id).disabled = false;
    }
  };

  el('rw-save').onclick = async () => {
    try {
      await writeConfig(currentConfig());
      clearBtn.style.display = '';
      status('Saved.');
    } catch (e) {
      status('Error: ' + e.message);
    }
  };

  el('rw-test').onclick = async () => {
    const token = el('rw-token').value.trim();
    if (!token) {
      status('Error: access token is required');
      return;
    }
    status('Testing token…');
    try {
      const r = await api.relay('GET', AUTH_URL, { Authorization: 'Token ' + token }, '');
      if (r.status === 204) status('Token OK.');
      else if (r.status === 401) status('Token rejected (HTTP 401).');
      else status('Unexpected response (HTTP ' + (r.status || r.error) + ').');
    } catch (e) {
      status('Error: ' + e.message);
    }
  };

  clearBtn.onclick = async () => {
    try {
      await writeConfig({});
      el('rw-token').value = '';
      clearBtn.style.display = 'none';
      status('Configuration cleared.');
    } catch (e) {
      status('Error: ' + e.message);
    }
  };

  const existing = await loadConfig();
  if (existing && existing.token) {
    el('rw-token').value = existing.token;
    const locs = existing.locations || {};
    el('rw-loc-later').checked = !!locs.later;
    el('rw-loc-shortlist').checked = !!locs.shortlist;
    el('rw-loc-feed').checked = !!locs.feed;
    el('rw-cap').value = String(existing.cap || DEFAULT_CAP);
    clearBtn.style.display = '';
    status('Configured. Press Sync to download new articles.');
  } else {
    status('Not configured yet.');
  }
});
