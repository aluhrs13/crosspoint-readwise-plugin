import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../readwise/plugin.js', import.meta.url), 'utf8');
const article = { id: 'doc-1', title: 'Café & 日本語', category: 'article',
  source_url: 'https://example.com/stories/article', author: 'A & B', language: 'ja' };

async function setup(t, options = {}) {
  const dom = new JSDOM('<div id="plugin"></div>');
  t.after(() => dom.window.close());
  const el = (id) => dom.window.document.getElementById('rw-' + id);
  const files = new Map();
  const requests = [], uploads = [], published = [], deleted = [], waits = [];
  const config = { token: 'test-token', locations: { later: true }, cap: 10 };
  let render;
  const api = {
    async writeFile(path) {
      assert.equal(path, '/.crosspoint/readwise-plugin.json');
      return { ok: options.saveOK !== false };
    },
    async fetchToSd(url, dest, headers) {
      assert.equal(headers.Authorization, 'Token test-token');
      requests.push(url);
      const params = new URL(url).searchParams;
      const result = options.reader ? await options.reader(params, requests.length) : {
        results: params.has('id') ? [{ ...article, html_content: options.html || '<p>Body</p>' }] : [article],
        nextPageCursor: null,
      };
      files.set(dest, JSON.stringify(result));
      return { status: result.status || 200, complete: result.complete !== false };
    },
  };
  async function fetch(url, init = {}) {
    if (url.startsWith('/download')) {
      const path = new URL(url, 'http://device').searchParams.get('path');
      return new Response(path === '/.crosspoint/readwise-plugin.json' ? JSON.stringify(config) : files.get(path));
    }
    if (url.startsWith('/api/files')) {
      return new Response(JSON.stringify(options.installed || []), { status: options.listStatus || 200 });
    }
    if (url.startsWith('/upload')) {
      uploads.push(init.body.get('file'));
      return new Response('upload result', { status: options.uploadStatus || 200 });
    }
    const fields = new URLSearchParams(init.body);
    if (url === '/rename') {
      if (options.renameStatus) return new Response('', { status: options.renameStatus });
      published.push(fields.get('name'));
      return new Response('OK');
    }
    if (url === '/delete') {
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
    sync: () => el('sync').onclick(), files };
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
  assert.equal(h.files.size, 0, 'JSON staging files removed');
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
    assert.equal(h.files.size, 0);
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
