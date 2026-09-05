import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);

async function loadPlugin(path, globals = {}) {
  let render;
  const context = vm.createContext({
    CrossPoint: {
      registerPlugin(fn) { render = fn; },
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    DataView,
    Map,
    Date,
    Math,
    Array,
    String,
    Number,
    Object,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
    atob,
    btoa,
    setTimeout,
    ...globals,
  });
  const source = await readFile(new URL(path, root), 'utf8');
  vm.runInContext(source, context, { filename: path });
  assert.equal(typeof render, 'function', path + ' should register a render function');
  return { render, context };
}

function fakeDocument(ids) {
  const elements = Object.fromEntries(ids.map((id) => [id, {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: id === 'lib-fulfill',
    onclick: null,
    onchange: null,
  }]));
  return {
    elements,
    getElementById(id) {
      assert.ok(elements[id], 'unexpected element lookup: ' + id);
      return elements[id];
    },
  };
}

function response({ status = 200, json, body = new ArrayBuffer(0), text = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return json; },
    async arrayBuffer() { return body; },
    async text() { return text; },
  };
}

class XmlElement {
  constructor(attrs, text = '') {
    this.attrs = attrs;
    this.textContent = text;
  }
  getAttribute(name) { return this.attrs[name] || null; }
}

class TinyXmlDocument {
  constructor(source) {
    this.source = source;
  }
  getElementsByTagName(name) {
    return name === 'parsererror' ? [] : [];
  }
  getElementsByTagNameNS(_namespace, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const paired = new RegExp(
      '<(?:[\\w.-]+:)?' + escaped + '\\b([^>]*)>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?' + escaped + '>',
      'gi');
    const selfClosing = new RegExp('<(?:[\\w.-]+:)?' + escaped + '\\b([^>]*)\\/\\s*>', 'gi');
    const out = [];
    let match;
    while ((match = paired.exec(this.source))) {
      out.push(new XmlElement(parseAttrs(match[1]), stripTags(match[2]).trim()));
    }
    while ((match = selfClosing.exec(this.source))) {
      out.push(new XmlElement(parseAttrs(match[1])));
    }
    return out;
  }
}

function parseAttrs(source) {
  const attrs = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(source))) attrs[match[1]] = match[2] ?? match[3] ?? '';
  return attrs;
}

function stripTags(source) {
  return source.replace(/<[^>]+>/g, '');
}

class TinyDomParser {
  parseFromString(source) { return new TinyXmlDocument(source); }
}

test('all plugin manifests satisfy the manifest contract', async () => {
  const plugins = ['hello', 'organize-by-author', 'protected-content', 'dictionaries', 'readwise'];
  for (const plugin of plugins) {
    const manifest = JSON.parse(await readFile(new URL(plugin + '/manifest.json', root), 'utf8'));
    assert.equal(typeof manifest.title, 'string', plugin + ' needs a title');
    assert.ok(manifest.title.trim(), plugin + ' needs a non-empty title');
    assert.ok(['files', 'settings'].includes(manifest.mount), plugin + ' has an invalid mount');
  }
});

test('hello renders its settings card', async () => {
  const { render } = await loadPlugin('hello/plugin.js');
  const container = { innerHTML: '' };
  render(container, { name: 'hello' });
  assert.match(container.innerHTML, /Hello from the SD card/);
  assert.match(container.innerHTML, /plugin\.js/);
});

test('organizer uses the creator file-as and moves a rights sidecar', async () => {
  const document = fakeDocument(['org-go', 'org-status']);
  const moves = [];
  const files = new Map([
    ['META-INF/container.xml',
      "<container><rootfiles><rootfile full-path='OPS/package.opf'/></rootfiles></container>"],
    ['OPS/package.opf',
      '<package xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<metadata><dc:title opf:file-as="Wrong Title">Title</dc:title>' +
      '<dc:creator id="author" opf:file-as="Le Guin, Ursula">Ursula K. Le Guin</dc:creator>' +
      '</metadata></package>'],
  ]);
  const JSZip = {
    async loadAsync() {
      return {
        file(path) {
          const content = files.get(path);
          return content === undefined ? null : { async: async () => content };
        },
      };
    },
  };
  async function fetch(url, options = {}) {
    if (url.startsWith('/api/files')) {
      return response({ json: [
        { name: 'Earthsea.epub', isDirectory: false, isEpub: true },
        { name: 'Earthsea.epub.rights', isDirectory: false, isEpub: false },
      ] });
    }
    if (url.startsWith('/download')) return response();
    if (url === '/mkdir') return response();
    if (url === '/move') {
      const form = new URLSearchParams(options.body);
      moves.push({ path: form.get('path'), dest: form.get('dest') });
      return response();
    }
    throw new Error('unexpected fetch: ' + url);
  }

  const { render } = await loadPlugin('organize-by-author/plugin.js', {
    document,
    window: { location: { search: '?path=%2FBooks' } },
    DOMParser: TinyDomParser,
    JSZip,
    fetch,
  });
  const container = { innerHTML: '' };
  render(container, { name: 'organize-by-author' });
  await document.elements['org-go'].onclick();

  assert.deepEqual(moves, [
    { path: '/Books/Earthsea.epub', dest: '/Books/Le Guin, Ursula' },
    { path: '/Books/Earthsea.epub.rights', dest: '/Books/Le Guin, Ursula' },
  ]);
  assert.match(document.elements['org-status'].textContent, /Filed 1/);
});

test('dictionaries installs through redirects and sets the active dictionary without clobbering settings', async () => {
  const document = fakeDocument([
    'fd-status', 'fd-list', 'fd-active', 'fd-set-active', 'fd-search', 'fd-active-note',
    'fd-install-afr-deu', 'fd-install-eng-deu', 'fd-remove-afr-deu', 'fd-remove-eng-deu',
  ]);
  const index = { items: [
    { id: 'afr-deu', title: 'Afrikaans - German', author: '4k entries, 0.1 MB',
      base: 'https://github.com/example/releases/download/freedict/',
      files: ['afr-deu.ifo', 'afr-deu.idx', 'afr-deu.dict.dz'] },
    { id: 'eng-deu', title: 'English - German', author: '460k entries, 31.3 MB',
      base: 'https://github.com/example/releases/download/freedict/',
      files: ['eng-deu.ifo', 'eng-deu.idx', 'eng-deu.dict.dz'] },
  ] };
  const writes = [];
  const downloads = [];
  const api = {
    async relay(method, url) {
      assert.equal(method, 'HEAD');
      if (url.includes('github.com/example')) {
        return { status: 302, body: '', headers: [['Location', url.replace('github.com/example', 'objects.example.com')]] };
      }
      return { status: 200, body: '', headers: [] };
    },
    async writeFile(path, dataB64) {
      writes.push({ path, data: Buffer.from(dataB64, 'base64').toString('utf8') });
      return { ok: true, bytes: dataB64.length };
    },
    async fetchToSd(url, dest) {
      downloads.push({ url, dest });
      return { status: 200, bytes: 1000, complete: true };
    },
  };
  async function fetch(url) {
    if (url.startsWith('https://raw.githubusercontent.com/')) return response({ json: index });
    if (url.startsWith('/api/files')) return response({ json: [{ name: 'afr-deu', isDirectory: true }] });
    if (url.startsWith('/download?path=%2F.crosspoint%2Fsettings.json')) {
      return response({ text: '{"fontPointSize":12,"dictionaryName":"afr-deu"}' });
    }
    throw new Error('unexpected fetch: ' + url);
  }

  const { render } = await loadPlugin('dictionaries/plugin.js', { document, fetch });
  await render({ innerHTML: '' }, api);

  assert.match(document.elements['fd-status'].textContent, /2 dictionaries available/);
  assert.match(document.elements['fd-active'].innerHTML, /afr-deu/);
  assert.equal(document.elements['fd-active'].value, 'afr-deu');
  assert.match(document.elements['fd-list'].innerHTML, /English - German/);

  // Install follows the release-asset redirect before streaming to SD.
  await document.elements['fd-install-eng-deu'].onclick();
  assert.equal(downloads.length, 3);
  assert.equal(downloads[0].url, 'https://objects.example.com/releases/download/freedict/eng-deu.ifo');
  assert.equal(downloads[0].dest, '/dictionaries/eng-deu/eng-deu.ifo');
  assert.equal(downloads[2].dest, '/dictionaries/eng-deu/eng-deu.dict.dz');

  // Setting the active dictionary rewrites settings.json but keeps other keys.
  document.elements['fd-active'].value = 'eng-deu';
  await document.elements['fd-set-active'].onclick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/.crosspoint/settings.json');
  const saved = JSON.parse(writes[0].data);
  assert.equal(saved.dictionaryName, 'eng-deu');
  assert.equal(saved.fontPointSize, 12);
});

test('protected content restores content.key, writes rights first, and fulfills without rewriting credentials', async () => {
  const document = fakeDocument([
    'lib-account-state', 'lib-user', 'lib-pass', 'lib-go', 'lib-acsm',
    'lib-refresh', 'lib-fulfill', 'lib-status',
  ]);
  const writes = [];
  const downloads = [];
  const deletes = [];
  const fulfillmentOperations = [];
  let savedCredential = '';
  let activationRedirected = false;
  const crypto = async (op, fields = {}) => {
    const zeros = (length) => btoa(String.fromCharCode(...new Uint8Array(length)));
    if (op === 'random') return { data: zeros(fields.len) };
    if (op === 'sha1') return { data: zeros(20) };
    if (op === 'keygen') return { public: 'cHVibGlj', private: 'cHJpdmF0ZQ==' };
    if (op === 'pubencrypt') return { data: zeros(128) };
    if (op === 'aesenc') return { data: zeros(16) };
    if (op === 'aesdec') return { data: 'cHJpdmF0ZQ==' };
    if (op === 'pkcs12') return { key: 'c2lnbmluZy1rZXk=', cert: 'c2lnbmluZy1jZXJ0' };
    if (op === 'sign') return { data: zeros(128) };
    throw new Error('unexpected crypto op: ' + op);
  };
  const relay = async (method, url, headers) => {
    assert.equal(Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent'), false);
    let body;
    if (url.endsWith('/ActivationServiceInfo') && !activationRedirected) {
      activationRedirected = true;
      return {
        status: 302,
        body: '',
        headers: [['location', '/adept/ActivationServiceInfo2']],
      };
    } else if (url.endsWith('/ActivationServiceInfo2')) {
      body = '<adept:service xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:authURL>https://adeactivate.adobe.com/adept</adept:authURL>' +
        '<adept:userInfoURL>https://adeactivate.adobe.com/user</adept:userInfoURL>' +
        '<adept:certificate>Y2VydA==</adept:certificate></adept:service>';
    } else if (url.endsWith('/AuthenticationServiceInfo')) {
      body = '<adept:service xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:certificate>YXV0aC1jZXJ0</adept:certificate></adept:service>';
    } else if (url.endsWith('/SignInDirect')) {
      body = '<adept:credentials xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:user>urn:uuid:user</adept:user><adept:pkcs12>cDEy</adept:pkcs12>' +
        '<adept:licenseCertificate>bGljLWNlcnQ=</adept:licenseCertificate>' +
        '<adept:encryptedPrivateLicenseKey>ZW5j</adept:encryptedPrivateLicenseKey>' +
        '</adept:credentials>';
    } else if (url.endsWith('/Activate')) {
      body = '<adept:activationToken xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:device>urn:uuid:device</adept:device></adept:activationToken>';
    } else if (url.includes('/LicenseServiceInfo?')) {
      assert.match(url, /licenseURL=https%3A%2F%2Flicense\.example\.overdrive\.com%2Fservice/);
      body = '<adept:licenseServiceInfo xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:certificate>bGljZW5zZS1jZXJ0</adept:certificate></adept:licenseServiceInfo>';
    } else if (url.endsWith('/Fulfill')) {
      body = '<adept:fulfillmentResult xmlns:adept="http://ns.adobe.com/adept" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/"><adept:resourceItemInfo>' +
        '<adept:src>https://download.example.overdrive.com/book.epub</adept:src>' +
        '<adept:licenseToken><adept:licenseURL>' +
        'https://license.example.overdrive.com/service</adept:licenseURL>' +
        '<adept:encryptedKey>a2V5</adept:encryptedKey></adept:licenseToken>' +
        '</adept:resourceItemInfo><dc:title>Test Book</dc:title></adept:fulfillmentResult>';
    } else if (url.endsWith('/Auth') || url.endsWith('/InitLicenseService')) {
      body = '<adept:ok xmlns:adept="http://ns.adobe.com/adept"/>';
    } else {
      throw new Error('unexpected relay: ' + method + ' ' + url);
    }
    return { status: 200, body, headers: [] };
  };
  const api = {
    crypto,
    relay,
    async writeFile(path, data) {
      writes.push({ path, data });
      if (path === '/.crosspoint/content.key') {
        savedCredential = Buffer.from(data, 'base64').toString('utf8');
      } else if (path.endsWith('.rights')) {
        fulfillmentOperations.push('rights');
      }
      return { ok: true, bytes: data.length };
    },
    async fetchToSd(url, dest, headers) {
      downloads.push({ url, dest, headers });
      fulfillmentOperations.push('download');
      return { status: 200, bytes: 1234 };
    },
  };
  const acsm =
    '<adept:fulfillmentToken xmlns:adept="http://ns.adobe.com/adept">' +
    '<adept:operatorURL>https://fulfill.example.overdrive.com/acs/</adept:operatorURL>' +
    '<adept:hmac>aG1hYw==</adept:hmac></adept:fulfillmentToken>';
  async function fetch(url, options = {}) {
    if (url === '/delete') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      deletes.push(new URLSearchParams(options.body).get('path'));
      return response();
    }
    if (url.startsWith('/api/files')) {
      const path = new URLSearchParams(url.split('?')[1]).get('path');
      if (path === '/.crosspoint') {
        return response({ json: savedCredential
          ? [{ name: 'content.key', isDirectory: false }]
          : [] });
      }
      if (path === '/Loans') {
        return response({ json: [{ name: 'library-loan.acsm', isDirectory: false }] });
      }
      return response({ json: [{ name: 'Test Book.epub', isDirectory: false }] });
    }
    if (url.startsWith('/download')) {
      const path = new URLSearchParams(url.split('?')[1]).get('path');
      if (path === '/.crosspoint/content.key') return response({ text: savedCredential });
      if (path === '/Loans/library-loan.acsm') return response({ text: acsm });
    }
    throw new Error('unexpected fetch: ' + url);
  }

  const { render } = await loadPlugin('protected-content/plugin.js', {
    document,
    window: { location: { search: '?path=%2FLoans' } },
    fetch,
  });
  await render({ innerHTML: '' }, api);
  assert.match(document.elements['lib-account-state'].textContent, /No content account/);
  assert.equal(document.elements['lib-acsm'].value, 'library-loan.acsm');
  document.elements['lib-user'].value = 'reader@example.com';
  document.elements['lib-pass'].value = 'secret';
  await document.elements['lib-go'].onclick();

  assert.equal(activationRedirected, true);
  assert.equal(document.elements['lib-pass'].value, '');
  assert.equal(writes[0].path, '/.crosspoint/content.key');
  assert.match(savedCredential, /^FREEINK-CONTENT-KEY 1/m);
  assert.match(savedCredential, /^protectedContentState: /m);
  const credentialAfterActivation = savedCredential;

  // Simulate reopening the File Manager: content.key should restore the
  // signing session, and the uploaded ACSM should be ready without pasting it.
  const reloadedDocument = fakeDocument([
    'lib-account-state', 'lib-user', 'lib-pass', 'lib-go', 'lib-acsm',
    'lib-refresh', 'lib-fulfill', 'lib-status',
  ]);
  const { render: renderReloaded } = await loadPlugin('protected-content/plugin.js', {
    document: reloadedDocument,
    window: { location: { search: '?path=%2FLoans' } },
    fetch,
  });
  await renderReloaded({ innerHTML: '' }, api);
  assert.match(reloadedDocument.elements['lib-account-state'].textContent, /Connected as reader@example\.com/);
  assert.equal(reloadedDocument.elements['lib-acsm'].value, 'library-loan.acsm');
  assert.equal(reloadedDocument.elements['lib-fulfill'].disabled, false);
  await reloadedDocument.elements['lib-fulfill'].onclick();

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].url, 'http://download.example.overdrive.com/book.epub');
  assert.equal(downloads[0].dest, '/Loans/Test Book.epub');
  assert.equal(Object.keys(downloads[0].headers).length, 0);
  assert.equal(writes[1].path, '/Loans/Test Book.epub.rights');
  assert.equal(writes.length, 2);
  assert.deepEqual(fulfillmentOperations, ['rights', 'download']);
  assert.equal(savedCredential, credentialAfterActivation);
  assert.deepEqual(deletes, ['/Loans/library-loan.acsm']);
  assert.match(reloadedDocument.elements['lib-status'].textContent, /Fetched “Test Book”/);
});

test('readwise syncs new articles as store-only EPUBs and skips installed or unsyncable docs', async () => {
  const document = fakeDocument([
    'rw-status', 'rw-token', 'rw-loc-later', 'rw-loc-shortlist', 'rw-loc-feed',
    'rw-cap', 'rw-sync', 'rw-save', 'rw-test', 'rw-clear', 'rw-progress',
  ]);
  document.elements['rw-clear'].style = {};

  const config = { token: 'tok123', locations: { later: true, shortlist: false, feed: true }, cap: 10 };
  const listLater = { results: [
    { id: 'newdoc1', title: 'Fresh: Article!', author: 'Jane Doe', site_name: 'Example',
      source_url: 'https://example.com/a', category: 'article', parent_id: null,
      first_opened_at: null, summary: 'Sum' },
    { id: 'olddoc1', title: 'Old Article', category: 'article', parent_id: null },
    { id: 'pdfdoc1', title: 'A PDF', category: 'pdf', parent_id: null },
    { id: 'hldoc1', title: 'A Highlight', category: 'highlight', parent_id: 'newdoc1' },
  ], nextPageCursor: null };
  const listFeed = { results: [
    { id: 'feeddoc1', title: 'Opened Feed Item', category: 'rss', parent_id: null,
      first_opened_at: '2026-08-01T00:00:00Z' },
    { id: 'feeddoc2', title: 'Unread Feed Item', category: 'rss', parent_id: null,
      first_opened_at: null, source_url: 'https://feeds.example/2' },
  ], nextPageCursor: null };
  const bodies = {
    newdoc1: { results: [{ id: 'newdoc1', html_content: '<p>Hello body</p>' }] },
    feeddoc2: { results: [{ id: 'feeddoc2', html_content: '<p>Feed body</p>' }] },
  };

  const sdFiles = new Map(); // fetchToSd dest -> JSON text served back over /download
  const fetchedToSd = [];
  const deletes = [];
  const uploads = [];
  const renames = [];
  const relayCalls = [];
  const api = {
    async relay(method, url, headers) {
      relayCalls.push({ method, url, headers });
      return { status: 204, body: '', headers: [] };
    },
    async writeFile() { return { ok: true }; },
    async fetchToSd(url, dest, headers) {
      fetchedToSd.push({ url, dest, headers });
      const params = new URL(url).searchParams;
      let payload;
      if (params.get('id')) payload = bodies[params.get('id')];
      else if (params.get('location') === 'later') payload = listLater;
      else if (params.get('location') === 'feed') payload = listFeed;
      if (!payload) throw new Error('unexpected fetchToSd: ' + url);
      sdFiles.set(dest, JSON.stringify(payload));
      return { status: 200, bytes: 1, complete: true };
    },
  };
  class FakeBlob {
    constructor(parts, opts) { this.parts = parts; this.opts = opts; }
  }
  class FakeFormData {
    append(name, blob, filename) { this.name = name; this.blob = blob; this.filename = filename; }
  }
  async function fetch(url, options = {}) {
    if (url.startsWith('/download?path=')) {
      const path = decodeURIComponent(url.slice('/download?path='.length));
      if (path === '/.crosspoint/readwise-plugin.json') return response({ text: JSON.stringify(config) });
      if (sdFiles.has(path)) return response({ text: sdFiles.get(path) });
      return response({ status: 404 });
    }
    if (url.startsWith('/api/files')) {
      return response({ text: JSON.stringify([{ name: 'Old Article [olddoc1].epub', isDirectory: false }]) });
    }
    if (url === '/delete') {
      deletes.push(new URLSearchParams(options.body).get('path'));
      return response();
    }
    if (url === '/rename') {
      renames.push(new URLSearchParams(options.body).get('name'));
      return response();
    }
    if (url.startsWith('/upload?path=')) {
      uploads.push({ dir: decodeURIComponent(url.slice('/upload?path='.length)), form: options.body });
      return response();
    }
    throw new Error('unexpected fetch: ' + url);
  }

  const { render } = await loadPlugin('readwise/plugin.js', {
    document, fetch,
    DOMParser: new JSDOM('').window.DOMParser, XMLSerializer: new JSDOM('').window.XMLSerializer,
    Blob: FakeBlob, FormData: FakeFormData,
    setTimeout: (fn) => { fn(); },
  });
  await render({ innerHTML: '' }, api);

  assert.equal(document.elements['rw-token'].value, 'tok123');
  assert.equal(document.elements['rw-loc-later'].checked, true);
  assert.equal(document.elements['rw-loc-shortlist'].checked, false);
  assert.equal(document.elements['rw-loc-feed'].checked, true);
  assert.match(document.elements['rw-status'].textContent, /Configured/);

  await document.elements['rw-test'].onclick();
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].url, 'https://readwise.io/api/v2/auth/');
  assert.equal(relayCalls[0].headers.Authorization, 'Token tok123');
  assert.match(document.elements['rw-status'].textContent, /Token OK/);

  await document.elements['rw-sync'].onclick();

  // Lists fetched for the enabled locations only, metadata-only, with the token.
  const listCalls = fetchedToSd.filter((f) => f.url.includes('location='));
  assert.deepEqual(listCalls.map((f) => new URL(f.url).searchParams.get('location')), ['later', 'feed']);
  for (const f of listCalls) {
    assert.equal(new URL(f.url).searchParams.get('withHtmlContent'), 'false');
  }
  for (const f of fetchedToSd) {
    assert.equal(f.headers.Authorization, 'Token tok123');
    assert.match(f.dest, /^\/\.crosspoint\/readwise-tmp-.+\.json$/);
  }
  assert.equal(new Set(fetchedToSd.map((f) => f.dest)).size, fetchedToSd.length,
    'temp file names must be unique');
  assert.deepEqual(deletes.filter((p) => p.endsWith('.json')).sort(), fetchedToSd.map((f) => f.dest).sort(),
    'every temp file gets a delete attempt');

  // Bodies fetched only for the two syncable new docs (installed, pdf,
  // highlight, and opened-feed docs all skipped).
  const bodyCalls = fetchedToSd.filter((f) => f.url.includes('withHtmlContent=true'));
  assert.deepEqual(bodyCalls.map((f) => new URL(f.url).searchParams.get('id')), ['newdoc1', 'feeddoc2']);

  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads.map((u) => u.dir), ['/Readwise', '/Readwise']);
  assert.deepEqual(renames,
    ['Fresh Article [newdoc1].epub', 'Unread Feed Item [feeddoc2].epub']);

  // Validate the first EPUB's zip layout on real bytes.
  function testCrc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  const zip = uploads[0].form.blob.parts[0];
  assert.ok(zip instanceof Uint8Array);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries = [];
  let off = 0;
  while (off + 4 <= zip.length && dv.getUint32(off, true) === 0x04034b50) {
    const crc = dv.getUint32(off + 14, true);
    const size = dv.getUint32(off + 18, true);
    assert.equal(dv.getUint16(off + 8, true), 0, 'entries must be stored, not compressed');
    assert.equal(dv.getUint32(off + 22, true), size, 'stored entries: sizes must match');
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const name = new TextDecoder().decode(zip.subarray(off + 30, off + 30 + nameLen));
    const data = zip.subarray(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + size);
    assert.equal(crc, testCrc32(data), 'CRC mismatch for ' + name);
    entries.push({ name, data });
    off += 30 + nameLen + extraLen + size;
  }
  assert.deepEqual(entries.map((e) => e.name),
    ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/toc.ncx', 'OEBPS/article.xhtml']);
  assert.equal(new TextDecoder().decode(entries[0].data), 'application/epub+zip');
  const eocd = zip.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, 'EOCD record present');
  assert.equal(dv.getUint16(eocd + 8, true), 5, 'EOCD entry count');
  assert.equal(dv.getUint32(eocd + 16, true), off, 'central directory offset');
  const opf = new TextDecoder().decode(entries[2].data);
  assert.match(opf, /urn:readwise:newdoc1/);
  assert.match(opf, /Fresh: Article!/);
  assert.match(opf, /Jane Doe/);
  const xhtml = new TextDecoder().decode(entries[4].data);
  assert.match(xhtml, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(xhtml, /Hello body/);

  assert.match(document.elements['rw-progress'].innerHTML, /later: 1 new/);
  assert.match(document.elements['rw-progress'].innerHTML, /feed: 1 new/);
  assert.doesNotMatch(document.elements['rw-progress'].innerHTML, /shortlist/);
  assert.match(document.elements['rw-status'].textContent, /Sync complete — 2 new articles\./);
  assert.equal(document.elements['rw-sync'].disabled, false);
});
