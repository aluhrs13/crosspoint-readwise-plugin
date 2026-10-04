import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../readwise/plugin.js', import.meta.url), 'utf8');
const article = { id: 'doc-1', title: 'Café & 日本語', category: 'article',
  source_url: 'https://example.com/stories/article', author: 'A & B', language: 'ja' };

test('Readwise requires the current firmware plugin host', async (t) => {
  const h = await setup(t, { oldFirmware: true });
  assert.match(h.dom.window.document.getElementById('plugin').textContent, /Update the reader firmware/);
  assert.equal(h.requests.length, 0);
});

for (const dir of ['/plugins/readwise', '/.plugins/readwise', '/.crosspoint/plugins/readwise']) {
  test('Readwise migrates legacy credentials into ' + dir, async (t) => {
    const h = await setup(t, { legacy: true, dir });
    assert.equal(JSON.parse(h.files.get(h.configPath)).token, 'test-token');
    assert.equal(h.files.has('/.crosspoint/readwise-plugin.json'), false);
    await h.sync();
    assert.equal(h.published.length, 1);
    assert.ok(h.deleted.some(path => path.startsWith(dir + '/readwise-tmp-')));
  });
}

test('Readwise keeps legacy credentials if migration fails', async (t) => {
  const h = await setup(t, { legacy: true, saveOK: false });
  assert.match(h.el('status').textContent, /Configuration error/);
  assert.ok(h.files.has('/.crosspoint/readwise-plugin.json'));
  assert.equal(h.files.has(h.configPath), false);
});

test('Readwise refuses corrupt or unreadable current config instead of restoring stale credentials', async (t) => {
  for (const options of [{ configText: 'invalid json' }, { configStatus: 500 }]) {
    const h = await setup(t, options);
    assert.match(h.el('status').textContent, /Configuration error/);
    assert.equal(h.writes.length, 0);
    await assert.rejects(h.actions.sync());
  }
});

test('Readwise clear removes both current and legacy credentials', async (t) => {
  const h = await setup(t);
  h.files.set('/.crosspoint/readwise-plugin.json', '{"token":"old-token"}');
  await h.el('clear').onclick();
  assert.deepEqual(JSON.parse(h.files.get(h.configPath)), {});
  assert.equal(h.files.has('/.crosspoint/readwise-plugin.json'), false);
  await assert.rejects(h.actions.sync(), /access token is required/);
});

test('Readwise reports legacy deletion failures when clearing credentials', async (t) => {
  const h = await setup(t, { deleteLegacyStatus: 500 });
  await h.el('clear').onclick();
  assert.match(h.el('status').textContent, /could not remove legacy/);
});

test('Readwise headless sync uses saved settings and returns a bounded job result', async (t) => {
  const h = await setup(t);
  h.el('token').value = 'unsaved-token';
  h.el('loc-later').checked = false;
  const result = await h.actions.sync();
  assert.equal(JSON.stringify(result), '{"added":1,"failed":0,"skipped":0,"limited":false}');
  assert.ok(JSON.stringify(result).length < 192);
  assert.equal(h.published.length, 1);
});

test('Readwise headless sync fails jobs when downloads fail and rejects concurrent execution', async (t) => {
  let release;
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const h = await setup(t, { reader: async () => { requested(); await pending; return { status: 401 }; } });
  const first = h.actions.sync();
  await started;
  await assert.rejects(h.actions.sync(), /already busy/);
  release();
  await assert.rejects(first, /Token rejected/);
  assert.equal(h.el('sync').disabled, false);
  const failed = await setup(t, { uploadStatus: 500 });
  await assert.rejects(failed.actions.sync(), /1 failed/);
});

test('Readwise leaves failed metadata writes and failed publication retryable', async (t) => {
  for (const options of [{ metadataOK: false }, { renameStatus: 400 }]) {
    const h = await setup(t, options);
    await h.sync();
    assert.equal(h.published.length, 0);
    assert.deepEqual(Array.from(h.files.keys()), [h.configPath]);
    assert.match(h.el('status').textContent, /1 failed/);
  }
});

async function setup(t, options = {}) {
  const dom = new JSDOM('<div id="plugin"></div>');
  t.after(() => dom.window.close());
  const el = (id) => dom.window.document.getElementById('rw-' + id);
  const files = new Map();
  const requests = [], uploads = [], published = [], deleted = [], waits = [];
  const config = { token: 'test-token', locations: { later: true }, cap: 10 };
  const pluginDir = options.dir || '/plugins/readwise';
  const configPath = pluginDir + '/config.json';
  if (!options.legacy) files.set(configPath, options.configText ?? JSON.stringify(options.config ?? config));
  else files.set('/.crosspoint/readwise-plugin.json', JSON.stringify(config));
  const actions = {}, writes = [];
  let outputFolderExists = !options.missingFolder;
  const listFolders = new Set(Object.keys(options.installedIn || {}));
  const uploadDirs = [], renamePaths = [];
  let mkdirCalls = 0;
  let render;
  const api = {
    dir: options.oldFirmware ? undefined : pluginDir,
    registerAction(name, fn) { actions[name] = fn; },
    async relay() { throw new Error('/api/relay 502: response truncated'); },
    async writeFile(path, data) {
      const value = Buffer.from(data, 'base64').toString('utf8');
      writes.push({ path, value });
      const ok = path.endsWith('.meta.json') ? options.metadataOK !== false : options.saveOK !== false;
      if (ok) files.set(path, value);
      return { ok };
    },
    async fetchToSd(url, dest, headers) {
      assert.equal(headers.Authorization, 'Token test-token');
      requests.push(url);
      const params = new URL(url).searchParams;
      const result = options.reader ? await options.reader(params, requests.length) : {
        results: params.has('id') ? [{ ...article, html_content: options.html || '<p>Body</p>' }] : [article],
        nextPageCursor: null,
      };
      files.set(dest + (result.complete === false ? '.part' : ''), JSON.stringify(result));
      return { status: result.status || 200, complete: result.complete !== false };
    },
  };
  async function fetch(url, init = {}) {
    if (url.startsWith('/download')) {
      const path = new URL(url, 'http://device').searchParams.get('path');
      if (path === configPath && options.configStatus) return new Response('', { status: options.configStatus });
      return new Response(files.get(path), { status: files.has(path) ? 200 : 404 });
    }
    if (url.startsWith('/api/files')) {
      const path = new URL(url, 'http://device').searchParams.get('path');
      if (path === '/') {
        return new Response(JSON.stringify(outputFolderExists ?
          [{ name: 'Readwise', isDirectory: !options.folderIsFile }] : []));
      }
      const entries = path === '/Readwise' ? [...(options.installed || []),
        ...Array.from(listFolders, name => ({ name, isDirectory: true }))] :
        (options.installedIn || {})[path.split('/').pop()] || [];
      return new Response(JSON.stringify(entries), { status: options.listStatus || 200 });
    }
    if (url.startsWith('/upload')) {
      assert.ok(outputFolderExists, 'destination folder must exist before upload');
      const dir = new URL(url, 'http://device').searchParams.get('path');
      assert.ok(listFolders.has(dir.split('/').pop()), 'list folder must exist before upload');
      uploadDirs.push(dir);
      uploads.push(init.body.get('file'));
      return new Response(options.uploadError || 'upload result', { status: options.uploadStatus || 200 });
    }
    const fields = new URLSearchParams(init.body);
    if (url === '/mkdir') {
      mkdirCalls++;
      if (options.mkdirStatus) return new Response('cannot create folder', { status: options.mkdirStatus });
      if (fields.get('path') === '/') {
        assert.equal(fields.get('name'), 'Readwise');
        outputFolderExists = true;
      } else {
        assert.equal(fields.get('path'), '/Readwise');
        assert.ok(outputFolderExists);
        listFolders.add(fields.get('name'));
      }
      return new Response('OK');
    }
    if (url === '/rename') {
      renamePaths.push(fields.get('path'));
      if (options.renameStatus) return new Response('', { status: options.renameStatus });
      published.push(fields.get('name'));
      return new Response('OK');
    }
    if (url === '/delete') {
      if (options.deleteLegacyStatus && fields.get('path') === '/.crosspoint/readwise-plugin.json') {
        return new Response('', { status: options.deleteLegacyStatus });
      }
      deleted.push(fields.get('path'));
      files.delete(fields.get('path'));
      return new Response('OK');
    }
    throw new Error('unexpected request: ' + url);
  }
  vm.runInNewContext(source, {
    CrossPoint: { registerPlugin(fn) { render = fn; } }, document: dom.window.document,
    DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer,
    URL, URLSearchParams, TextEncoder, Uint8Array, Uint32Array, DataView, Blob, FormData,
    btoa, fetch, setTimeout(fn, delay) { waits.push(delay); fn(); },
  });
  await render(dom.window.document.getElementById('plugin'), api);
  return { el, requests, uploads, published, deleted, waits, dom,
    sync: () => el('sync').onclick(), files, actions, writes, configPath, pluginDir,
    mkdirCalls: () => mkdirCalls, uploadDirs, renamePaths };
}

async function unzip(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const entries = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const start = offset + 30 + nameLen + view.getUint16(offset + 28, true);
    entries.set(new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLen)),
      new TextDecoder().decode(bytes.slice(start, start + size)));
    offset = start + size;
  }
  return entries;
}

test('Readwise converts actual HTML to safe, well-formed XHTML with text and links preserved', async (t) => {
  const h = await setup(t, { html: '<p>Hello &amp; 日本語 <img alt="a &amp; b" src="https://evil/image"> after</p>' +
    '<script>bad()</script><iframe src="https://evil"></iframe><p onclick="bad()">kept</p>' +
    '<a href="javascript:bad()">unsafe</a><a href="../other?q=1&amp;x=2">relative</a>' +
    '<o:p>Word text</o:p><p>' + 'Long article '.repeat(8000) + '</p>' });
  await h.sync();
  assert.equal(h.published.length, 1);
  assert.ok(h.uploads[0].size > 32000, 'large content uses streamed multipart upload');
  assert.match(h.uploads[0].name, /\.tmp$/);
  assert.match(h.published[0], /\[doc-1\]\.epub$/);
  const entries = await unzip(h.uploads[0]);
  const parser = new h.dom.window.DOMParser();
  for (const [name, text] of entries) {
    if (name === 'mimetype') continue;
    assert.equal(parser.parseFromString(text, 'application/xml').querySelector('parsererror'), null, name);
  }
  const xml = entries.get('OEBPS/article.xhtml');
  const doc = parser.parseFromString(xml, 'application/xml');
  assert.match(doc.documentElement.textContent, /Hello & 日本語 \[Image: a & b\] after/);
  assert.match(doc.documentElement.textContent, /Word text/);
  assert.doesNotMatch(xml, /javascript:|onclick=|<script|<iframe|<img/);
  assert.ok(Array.from(doc.getElementsByTagName('a')).some((a) =>
    a.getAttribute('href') === 'https://example.com/other?q=1&x=2'), xml.slice(0, 1500));
  assert.match(entries.get('OEBPS/content.opf'), /<dc:language>ja<\/dc:language>/);
  assert.ok(!Array.from(h.files.keys()).some(path => path.includes('readwise-tmp-')), 'JSON staging files removed');
  const metadata = h.writes.find(write => write.path.endsWith('.epub.meta.json'));
  assert.deepEqual(JSON.parse(metadata.value), { readwise_id: 'doc-1', source: 'readwise' });
});

test('Readwise follows opaque cursors and deduplicates across pages', async (t) => {
  const cursor = 'opaque+/=& cursor';
  const h = await setup(t, { reader(p) {
    if (p.has('id')) return { results: [{ ...article, html_content: '<p>Body</p>' }] };
    if (p.has('pageCursor')) {
      assert.equal(p.get('pageCursor'), cursor);
      return { results: [article], nextPageCursor: null };
    }
    return { results: [article], nextPageCursor: cursor };
  } });
  await h.sync();
  assert.equal(h.requests.length, 3);
  assert.equal(h.published.length, 1);
  assert.ok(h.waits.some((n) => n > 0 && n <= 3100));
});

for (const requestType of ['list', 'body']) {
  test('Readwise retries a rate-limited ' + requestType + ' once', async (t) => {
    let limited = false;
    const h = await setup(t, { reader(p) {
      if (!limited && p.has('id') === (requestType === 'body')) {
        limited = true;
        return { status: 429 };
      }
      return { results: p.has('id') ? [{ ...article, html_content: '<p>Body</p>' }] : [article] };
    } });
    await h.sync();
    assert.equal(h.published.length, 1);
    assert.equal(h.waits.filter((n) => n === 60000).length, 1);
  });
}

for (const failure of ['upload', 'rename']) {
  test('Readwise reports ' + failure + ' failure and never publishes a partial EPUB', async (t) => {
    const h = await setup(t, { [failure + 'Status']: 400 });
    await h.sync();
    assert.equal(h.published.length, 0);
    assert.match(h.el('status').textContent, /1 failed/);
    assert.ok(h.deleted.some((p) => p.endsWith('.tmp')));
    assert.equal(h.el('sync').disabled, false);
  });
}

test('Readwise skips missing HTML without saving a summary as the article', async (t) => {
  const h = await setup(t, { reader(p) {
    return { results: [{ ...article, summary: 'Only a summary', ...(p.has('id') ? { html_content: null } : {}) }] };
  } });
  await h.sync();
  await h.sync();
  assert.equal(h.uploads.length, 0);
  assert.equal(h.requests.filter((url) => new URL(url).searchParams.has('id')).length, 2);
  assert.match(h.el('progress').textContent, /skipped \(no content\)/);
});

test('Readwise rejects incomplete and malformed responses instead of reporting up to date', async (t) => {
  for (const result of [{ status: 200, complete: false }, { results: 'invalid' }, {}]) {
    const h = await setup(t, { reader: () => result });
    await h.sync();
    assert.match(h.el('status').textContent, /1 failed/);
    assert.equal(h.uploads.length, 0);
    assert.deepEqual(Array.from(h.files.keys()), [h.configPath]);
  }
});

test('Readwise aborts on rejected credentials and restores controls', async (t) => {
  const h = await setup(t, { reader: () => ({ status: 401 }) });
  await h.sync();
  assert.match(h.el('status').textContent, /Token rejected/);
  assert.equal(h.requests.length, 1);
  for (const id of ['sync', 'save', 'test', 'clear']) assert.equal(h.el(id).disabled, false);
});

test('Readwise reports SD listing and config write errors', async (t) => {
  const h = await setup(t, { listStatus: 500, saveOK: false });
  await h.sync();
  assert.match(h.el('status').textContent, /could not list/);
  assert.equal(h.requests.length, 0);
  await h.el('save').onclick();
  assert.match(h.el('status').textContent, /could not save/);
});

test('Readwise bounds repeated cursors and refuses unsafe IDs', async (t) => {
  const h = await setup(t, { reader: () => ({
    results: [{ ...article, id: '../../bad' }], nextPageCursor: 'same',
  }) });
  await h.sync();
  assert.equal(h.requests.length, 2);
  assert.equal(h.uploads.length, 0);
  assert.match(h.el('progress').textContent, /repeated a page cursor/);
});

test('Readwise reports a bounded scan as incomplete', async (t) => {
  const h = await setup(t, { reader: (_p, n) => ({ results: [], nextPageCursor: 'page' + n }) });
  await h.sync();
  assert.equal(h.requests.length, 15);
  assert.match(h.el('progress').textContent, /scan limit reached/);
  assert.doesNotMatch(h.el('progress').textContent, /up to date/);
});

test('Readwise creates the upload folder on first sync and reuses it', async (t) => {
  const h = await setup(t, { missingFolder: true });
  await h.sync();
  assert.equal(h.published.length, 1);
  assert.equal(h.mkdirCalls(), 2);
  await h.sync();
  assert.equal(h.mkdirCalls(), 2);
});

test('Readwise stops before fetching articles when its folder cannot be created', async (t) => {
  const h = await setup(t, { missingFolder: true, mkdirStatus: 500 });
  await h.sync();
  assert.match(h.el('status').textContent, /mkdir failed/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.uploads.length, 0);
});

test('Readwise reports a file blocking the output folder', async (t) => {
  const h = await setup(t, { folderIsFile: true });
  await h.sync();
  assert.match(h.el('status').textContent, /not a folder/);
  assert.equal(h.requests.length, 0);
});

test('Readwise includes the device upload error in the report', async (t) => {
  const h = await setup(t, { uploadStatus: 400, uploadError: 'Failed to create file on SD card' });
  await h.sync();
  assert.match(h.el('progress').textContent, /upload failed \(HTTP 400\): Failed to create file on SD card/);
});

for (const [location, folder] of [['later', 'Later'], ['shortlist', 'Shortlist'], ['feed', 'Feed']]) {
  test('Readwise publishes and cleans temporary files in the ' + folder + ' folder', async (t) => {
    const h = await setup(t);
    for (const list of ['later', 'shortlist', 'feed']) h.el('loc-' + list).checked = list === location;
    await h.sync();
    assert.deepEqual(h.uploadDirs, ['/Readwise/' + folder]);
    assert.equal(h.published.length, 1);
    assert.ok(h.renamePaths[0].startsWith('/Readwise/' + folder + '/'));
    assert.ok(h.deleted.includes(h.renamePaths[0]));
  });
}

test('Readwise skips articles already in the legacy root or a disabled list folder', async (t) => {
  for (const options of [
    { installed: [{ name: 'Old [doc-1].epub', size: 100 }] },
    { installedIn: { Feed: [{ name: 'Old [doc-1].epub', size: 100 }] } },
  ]) {
    const h = await setup(t, options);
    await h.sync();
    assert.equal(h.uploads.length, 0);
    assert.equal(h.requests.length, 1, 'only list metadata is fetched');
    assert.match(h.el('progress').textContent, /up to date/);
  }
});

test('Readwise token test bypasses the relay and validates a Reader JSON response', async (t) => {
  const h = await setup(t, { reader: () => ({ results: [] }) });
  await h.el('test').onclick();
  assert.match(h.el('status').textContent, /Token OK/);
  assert.deepEqual(h.requests, ['https://readwise.io/api/v3/list/?limit=1&withHtmlContent=false']);
  assert.deepEqual(Array.from(h.files.keys()), [h.configPath]);
  assert.equal(h.uploads.length, 0);
  for (const id of ['sync', 'save', 'test', 'clear']) assert.equal(h.el(id).disabled, false);
});

test('Readwise token test distinguishes rejected credentials from broken responses', async (t) => {
  for (const [result, message] of [
    [{ status: 401 }, /Token rejected/],
    [{ status: 403 }, /Token rejected/],
    [{ status: 502 }, /Connection test failed/],
    [{ results: 'invalid' }, /Connection test failed/],
  ]) {
    const h = await setup(t, { reader: () => result });
    await h.el('test').onclick();
    assert.match(h.el('status').textContent, message);
    assert.deepEqual(Array.from(h.files.keys()), [h.configPath]);
    for (const id of ['sync', 'save', 'test', 'clear']) assert.equal(h.el(id).disabled, false);
  }
});

for (const outcome of ['saved', 'failed', 'skipped']) {
  test('Readwise caps attempts and advances live progress when articles are ' + outcome, async (t) => {
    const liveProgress = [];
    let h;
    h = await setup(t, {
      uploadStatus: outcome === 'failed' ? 400 : 200,
      reader(p) {
        liveProgress.push(h.el('progress').textContent);
        if (p.has('id')) return { results: [{ ...article, id: p.get('id'),
          html_content: outcome === 'skipped' ? null : '<p>Body</p>' }] };
        return { results: Array.from({ length: 12 }, (_, i) => ({ ...article, id: 'doc-' + i })),
          nextPageCursor: 'more' };
      },
    });
    h.el('cap').value = '2';
    await h.sync();
    assert.equal(h.requests.filter(url => new URL(url).searchParams.has('id')).length, 2);
    assert.equal(h.requests.length, 3, 'stop without requesting another list page');
    assert.equal(h.published.length, outcome === 'saved' ? 2 : 0);
    assert.ok(liveProgress.some(text => text.includes('2/2 attempted')));
    if (outcome === 'failed') assert.ok(liveProgress.some(text => text.includes('1 failed')));
    if (outcome === 'skipped') assert.ok(liveProgress.some(text => text.includes('1 skipped')));
  });
}
