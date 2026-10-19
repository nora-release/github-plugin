import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, texts, connection } from './fixtures/plugin-fixture.js';

const head = 'a'.repeat(40);
const patch = '@@ -1,2 +1,2 @@\n-const before = 1;\n+const after = 2;\n export { value };';
const pull = (number = 1, extra = {}) => issue(number, `Pull ${number}`, { pull_request: {}, html_url: `https://github.com/alice/project/pull/${number}`, repository: { full_name: 'alice/project' }, head: { sha: head, ref: 'feature' }, base: { ref: 'main' }, draft: true, mergeable: true, ...extra });
const file = (filename, extra = {}) => ({ filename, status: 'modified', patch, additions: 1, deletions: 1, blob_url: `https://github.com/alice/project/blob/${head}/${filename}`, ...extra });
function routeFor(files, override = () => undefined) {
  return async (url, args) => {
    assert.ok(!args.method || args.method === 'GET', 'Reading a file never mutates GitHub');
    const response = override(url, args);
    if (response !== undefined) return response;
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    if (url.pathname === '/search/issues') return searchBody([pull()]);
    if (/\/pulls\/\d+$/.test(url.pathname)) return body(pull(Number(url.pathname.split('/').at(-1))));
    if (url.pathname === '/repos/alice/project') return body({ ...repo(), permissions: { push: true } });
    if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
    if (url.pathname.includes('/commits/') && url.pathname.endsWith('/status')) return body({ statuses: [] });
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
    if (url.pathname.endsWith('/files')) return body(typeof files === 'function' ? files() : files);
    return body([]);
  };
}
async function openFiles(f, number = 1) {
  await f.renderReady({}); await f.renderReady({ action: 'kind:pulls' });
  await f.renderReady({ action: `item:item-alice/project/${number}` });
  return f.render({ action: 'pr-tab:files' });
}
const split = current => nodes(current).find(node => node.id === 'pr-file-workspace');

test('The shipped SDK native file selection and narrow back control are read only and cache the exact patch', async () => {
  const files = [file('src/main.ts'), file('src/你好 world.swift', { patch: '@@ -1 +1 @@\n-let old = "🙂"\n+let new = "汉"' })];
  const f = fixture({ saved: connection, route: routeFor(files) });
  let current = await openFiles(f);
  assert.equal(split(current).value, 'list');
  assert.equal(nodes(current).find(node => node.type === 'diff').text, patch);
  const initialReads = f.requests.length;
  current = await f.render({ action: 'pr-file:1' });
  assert.equal(f.requests.length, initialReads, 'Selecting cached files cannot read source blobs or re-fetch details');
  assert.equal(split(current).value, 'detail');
  assert.equal(nodes(current).find(node => node.type === 'diff').text, files[1].patch);
  assert.equal(nodes(current).find(node => node.type === 'diff').subtitle, files[1].filename);
  assert.ok(nodes(split(current).children[0]).some(node => node.action === 'pr-file:1' && node.value === 'selected'));
  current = await f.render({ action: 'pr-files-back' });
  assert.equal(split(current).value, 'list');
  assert.equal(nodes(current).find(node => node.type === 'diff').text, files[1].patch);
  for (const action of ['pr-file:-1', 'pr-file:99', 'pr-file:Infinity', 'pr-file:1e1', 'pr-file:', 'pr-file:1.2']) {
    current = await f.render({ action });
    assert.equal(nodes(current).find(node => node.type === 'diff').subtitle, files[1].filename);
    assert.equal(split(current).value, 'list');
  }
  await f.render({ action: 'pr-tab:discussion' });
  current = await f.render({ action: 'pr-tab:files' });
  assert.equal(nodes(current).find(node => node.type === 'diff').subtitle, files[1].filename);
  assert.equal(f.requests.length, initialReads);
  assert.equal(f.writes.length, 0); assert.equal(f.links.length, 0);
});

test('Filename identity survives refresh reordering and missing old-host diff support keeps the modern detail', async () => {
  let files = [file('src/first.ts'), file('src/second.swift')];
  const f = fixture({ saved: connection, route: routeFor(() => files) });
  await openFiles(f); await f.render({ action: 'pr-file:1' });
  files = [files[1], files[0]];
  const refreshed = await f.renderReady({ action: 'refresh-detail' });
  assert.equal(nodes(refreshed).find(node => node.type === 'diff').subtitle, 'src/second.swift');
  assert.ok(nodes(split(refreshed).children[0]).some(node => node.action === 'pr-file:0' && node.value === 'selected'));
  assert.equal(split(refreshed).value, 'detail');
  const older = fixture({ saved: connection, unavailableViewKinds: ['diff'], route: routeFor(files) });
  const compatible = await openFiles(older);
  assert.equal(nodes(compatible).find(node => node.id === 'item-details').type, 'detail');
  assert.ok(nodes(compatible).some(node => node.type === 'tabBar' && node.id === 'pr-tabs'));
  assert.ok(nodes(compatible).some(node => node.type === 'markdown' && node.text.includes(patch)));
  assert.ok(!nodes(compatible).some(node => node.type === 'diff'));
  assert.equal(f.writes.length, 0); assert.equal(older.writes.length, 0);
});

test('File API pages remain lazy and retain the selected filename while appending another page', async () => {
  const first = file('src/first.ts'), second = file('src/second.ts');
  const f = fixture({ saved: connection, route: routeFor([], url => {
    if (!url.pathname.endsWith('/files')) return undefined;
    assert.equal(url.searchParams.get('per_page'), '30');
    return url.searchParams.get('page') === '1'
      ? body([first], 200, { link: '<https://api.github.com/repos/alice/project/pulls/1/files?page=2>; rel="next"' }) : body([second]);
  }) });
  await f.renderReady({}); await f.renderReady({ action: 'kind:pulls' }); await f.renderReady({ action: 'item:item-alice/project/1' });
  assert.ok(!f.requests.some(request => new URL(request.url).pathname.endsWith('/files')));
  let current = await f.render({ action: 'pr-tab:files' });
  assert.ok(nodes(current).some(node => node.action === 'pr-more:files'));
  await f.render({ action: 'pr-file:0' });
  current = await f.render({ action: 'pr-more:files' });
  assert.equal(nodes(current).find(node => node.type === 'diff').subtitle, first.filename);
  assert.ok(nodes(current).some(node => node.action === 'pr-file:1'));
  current = await f.render({ action: 'pr-file:1' });
  assert.equal(nodes(current).find(node => node.type === 'diff').subtitle, second.filename);
  const reads = f.requests.filter(request => new URL(request.url).pathname.endsWith('/files'));
  assert.equal(reads.length, 2);
  assert.ok(reads.every(request => !request.method || request.method === 'GET'));
});

test('A full PR feed and 200 long file names keep both selected tails and the original Unicode patch within native limits', async () => {
  const selectedPatch = '@@ -0,0 +1,1 @@\n+' + '🙂汉'.repeat(9000);
  const longPath = '目录/'.repeat(150);
  const files = Array.from({ length: 200 }, (_, index) => file(`src/${longPath}/${index}.ts`, { patch: index === 199 ? selectedPatch : patch, additions: 1, deletions: index === 199 ? 0 : 1 }));
  const feed = Array.from({ length: 400 }, (_, index) => pull(index + 1, { body: '', title: `PR ${index + 1} / ${'Repository activity / '.repeat(11)}` }));
  const f = fixture({ saved: connection, route: routeFor([], url => {
    if (url.pathname === '/search/issues') {
      const page = Number(url.searchParams.get('page'));
      return searchBody(feed.slice((page - 1) * 50, page * 50), 200, page < 8 ? { link: `<https://api.github.com/search/issues?page=${page + 1}>; rel="next"` } : {});
    }
    if (!url.pathname.endsWith('/files')) return undefined;
    const page = Number(url.searchParams.get('page'));
    return body(files.slice((page - 1) * 30, page * 30), 200, page < 7 ? { link: `<https://api.github.com/repos/alice/project/pulls/400/files?page=${page + 1}>; rel="next"` } : {});
  }) });
  await f.renderReady({}); await f.renderReady({ action: 'kind:pulls' });
  for (let page = 2; page <= 8; page++) await f.render({ action: 'more-items' });
  await f.renderReady({ action: 'item:item-alice/project/400' }); await f.render({ action: 'pr-tab:files' });
  for (let page = 2; page <= 7; page++) await f.render({ action: 'pr-more:files' });
  const current = await f.render({ action: 'pr-file:199' });
  const normalized = value => ({ ...value, options: value.options || [], disabled: value.disabled || false,
    children: (value.children || []).map(normalized), items: (value.items || []).map(normalized) });
  const encoded = JSON.stringify(normalized(current)).replace(/\//g, '\\/');
  assert.ok(nodes(current).length <= 950, `Native node count: ${nodes(current).length}`);
  assert.ok(Buffer.byteLength(encoded) <= 400 * 1024, `Native encoded bytes: ${Buffer.byteLength(encoded)}`);
  assert.ok(nodes(current).some(node => node.action === 'item:item-alice/project/1'));
  assert.ok(nodes(current).some(node => node.action === 'item:item-alice/project/400'));
  assert.ok(nodes(current).some(node => node.action === 'pr-file:0'));
  assert.ok(nodes(current).some(node => node.action === 'pr-file:199' && node.value === 'selected'));
  assert.equal(nodes(current).find(node => node.type === 'diff').text, selectedPatch);
  assert.equal(nodes(current).find(node => node.type === 'diff').subtitle, files.at(-1).filename);
  assert.ok(!texts(current).includes('Patch shortened'));
  assert.equal(f.writes.length, 0);
});
