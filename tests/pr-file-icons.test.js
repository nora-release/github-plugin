import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fixture, body, searchBody, repo, issue, nodes, connection } from './fixtures/plugin-fixture.js';

const head = 'a'.repeat(40);
const patch = '@@ -1 +1 @@\n-before\n+after';
const pull = issue(1, 'Review changed files', { pull_request: {}, html_url: 'https://github.com/alice/project/pull/1',
  repository: { full_name: 'alice/project' }, head: { sha: head, ref: 'feature' }, base: { ref: 'main' }, draft: true });
const changedFile = (filename, extra = {}) => ({ filename, status: 'modified', patch, additions: 1, deletions: 1, ...extra });

function host(files, capability) {
  return fixture({ saved: connection, supportsFileIcons: capability, route: async (url, args) => {
    assert.ok(!args.method || args.method === 'GET');
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    if (url.pathname === '/search/issues') return searchBody([pull]);
    if (url.pathname === '/repos/alice/project/pulls/1') return body(pull);
    if (url.pathname === '/repos/alice/project') return body({ ...repo(), permissions: { push: true } });
    if (url.pathname.endsWith('/files')) return body(files);
    if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
    if (url.pathname.endsWith('/status')) return body({ statuses: [] });
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
    return body([]);
  } });
}

async function openFiles(f) {
  await f.renderReady({});
  await f.render({ action: 'kind:pulls' });
  await f.render({ action: 'item:item-alice/project/1' });
  return f.render({ action: 'pr-tab:files' });
}

const fileRows = view => nodes(view).filter(node => node.type === 'itemRow' && /^pr-file:\d+$/.test(node.action || ''));

test('The SDK receives complete filename hints for shared native file icons without fetching file contents', async () => {
  const files = ['package.json', 'pnpm-lock.yaml', 'src/index.ts', 'src/components/Main.tsx', '文档/🙂.unknown',
    `.github/${'nested/'.repeat(35)}${'long-name-'.repeat(20)}.json`].map(name => changedFile(name));
  files.push(changedFile('config/package.json', { status: 'renamed', previous_filename: 'config/package.txt', additions: 0, deletions: 0 }));
  files.push(changedFile('src/new.ts', { status: 'added', deletions: 0 }));
  files.push(changedFile('src/old.ts', { status: 'removed', additions: 0 }));
  const f = host(files, true), legacy = host(files, false);
  let current = await openFiles(f);
  const oldView = await openFiles(legacy), rows = fileRows(current), oldRows = fileRows(oldView);
  assert.equal(rows.length, files.length);
  assert.deepEqual(rows.map(row => row.fileIconPath), files.map(file => file.filename));
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map(({ fileIconPath, ...row }) => row))), JSON.parse(JSON.stringify(oldRows)), 'The icon hint preserves status, line counts, selection, actions, and labels');
  assert.ok(rows[5].text.endsWith('…'));
  assert.ok(rows[5].subtitle.endsWith('…'));
  assert.notEqual(rows[5].text, files[5].filename.split('/').at(-1), 'A shortened display label must not shorten the icon hint');
  assert.equal(rows[6].fileIconPath, 'config/package.json', 'Renamed files resolve the new filename');
  assert.equal(rows[6].symbol, 'arrow.right');
  assert.equal(rows[7].symbol, 'doc.badge.plus');
  assert.equal(rows[8].symbol, 'doc.badge.minus');
  assert.ok(nodes(current).filter(node => node.fileIconPath !== undefined).every(node => node.type === 'itemRow'));
  const reads = f.requests.length;
  for (let index = 0; index < files.length; index++) {
    current = await f.render({ action: `pr-file:${index}` });
    assert.equal(fileRows(current).find(row => row.value === 'selected').fileIconPath, files[index].filename);
    assert.equal(nodes(current).find(node => node.type === 'diff').subtitle, files[index].filename);
  }
  assert.equal(f.requests.length, reads, 'Native icon resolution must not fetch GitHub source blobs or read files');
  assert.deepEqual(f.requests.map(request => request.url), legacy.requests.map(request => request.url));
  assert.equal(f.writes.length, 0);
  assert.equal(f.links.length, 0);
  assert.equal(f.drafts.length, 0);
});

test('Absent false and nonboolean file icon capabilities preserve existing file row symbols', async () => {
  for (const capability of [undefined, false, null, 'true', 1]) {
    const current = await openFiles(host([changedFile('package.json'), changedFile('pnpm-lock.yaml')], capability));
    assert.equal(fileRows(current).length, 2);
    assert.ok(fileRows(current).every(row => !Object.hasOwn(row, 'fileIconPath') && row.symbol === 'doc.text'));
  }
});

test('Unsupported filename hints keep usable rows without truncating or rejecting the native view', async () => {
  const files = ['src/control\u0000.ts', 'src/format\u200b.ts', 'src/line\u2028.ts', 'src/paragraph\u2029.ts'].map(name => changedFile(name));
  files.push(changedFile('src/文件.未知'));
  const f = host(files, true), current = await openFiles(f), rows = fileRows(current);
  assert.equal(rows.length, files.length);
  assert.ok(rows.slice(0, -1).every(row => !Object.hasOwn(row, 'fileIconPath') && row.symbol === 'doc.text'));
  assert.equal(rows.at(-1).fileIconPath, files.at(-1).filename);
  const reads = f.requests.length;
  const selected = await f.render({ action: 'pr-file:1' });
  assert.ok(fileRows(selected).some(row => row.action === 'pr-file:1' && row.value === 'selected'));
  assert.ok(nodes(selected).some(node => node.text === 'Preview unavailable'));
  assert.equal(f.requests.length, reads);
});

test('Filename icon hints keep exact UTF-8 boundaries and omit empty oversized or malformed paths', () => {
  const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');
  const start = source.indexOf('function createPullRequestView('), end = source.indexOf('const panelID', start);
  const createView = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
  const api = createView({ node: (type, properties = {}, children = []) => ({ type, ...properties, children }),
    t: en => en, boundedText: value => String(value), displayedBody: value => value, short: value => String(value),
    itemStatus: () => ({ text: 'Open', tone: 'success' }), itemDate: () => '',
    supportsNativeLayout: true, supportsNativeDiff: true, supportsFileIcons: true });
  const valid = `${'汉'.repeat(1363)}.jsonxx`, invalid = ['', `${valid}x`, 'src/unpaired\ud800.ts', 'src/unpaired\udfff.ts'];
  assert.equal(Buffer.byteLength(valid), 4096);
  const section = items => ({ items, loaded: true, loading: false, error: '', notice: '', nextPage: null });
  const files = [...invalid, valid].map(name => changedFile(name));
  const current = { repo: 'alice/project', number: 1, headSHA: head, tab: 'files', item: pull,
    sections: Object.fromEntries(['comments', 'reviews', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows', 'commits', 'files'].map(name => [name, section(name === 'files' ? files : [])])) };
  const rows = api.nativeContent(current).flatMap(nodes).filter(node => node.type === 'itemRow' && /^pr-file:\d+$/.test(node.action || ''));
  assert.equal(rows.length, files.length);
  assert.ok(rows.slice(0, -1).every(row => !Object.hasOwn(row, 'fileIconPath')));
  assert.equal(rows.at(-1).fileIconPath, valid);
});
