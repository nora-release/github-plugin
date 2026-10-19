import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, texts, connection, deferred } from './fixtures/plugin-fixture.js';

const head = 'a'.repeat(40);
const tick = () => new Promise(resolve => setImmediate(resolve));
const pull = (number, extra = {}) => issue(number, `Pull ${number}`, { pull_request: {},
  html_url: `https://github.com/alice/project/pull/${number}`, repository: { full_name: 'alice/project' },
  head: { ref: 'feature', sha: head }, base: { ref: 'main' }, ...extra });
function currentHost({ items = [pull(1), pull(2)], detail = async number => body(pull(number)), ...options } = {}) {
  return fixture({ saved: connection, supportsDetailAside: true, ...options, route: async (url, args) => {
    assert.ok(!args.method || args.method === 'GET', 'Loading a selection only reads GitHub');
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    if (url.pathname === '/search/issues') return searchBody(items);
    if (/\/pulls\/\d+$/.test(url.pathname)) return detail(Number(url.pathname.split('/').at(-1)));
    if (url.pathname === '/repos/alice/project') return body({ ...repo(), permissions: { push: true } });
    if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [{ id: 11, head_sha: head, conclusion: 'success' }] });
    if (url.pathname.endsWith('/status')) return body({ statuses: [] });
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
    return body([]);
  } });
}
async function list(f) { await f.renderReady({}); await f.render({ action: 'kind:pulls' }); }
const detailNode = page => nodes(page).find(node => node.id === 'item-details');
const tabs = page => nodes(page).find(node => node.id === 'pr-tabs');
const loading = page => nodes(page).find(node => node.id === 'item-details-loading');
const select = number => ({ action: `item:item-alice/project/${number}` });

test('The first PR immediately returns a native loading shell with inert current-item tabs and a matching aside', async () => {
  const started = deferred(), release = deferred();
  const f = currentHost({ items: [pull(1, { comments: 2 })], detail: async number => {
    started.resolve(); await release.promise; return body(pull(number, { body: 'Complete description', commits: 4, changed_files: 3 }));
  } });
  await list(f);
  const notificationsBeforeCompletion = f.invalidations.length;
  let returned = false;
  const opening = f.render(select(1)).then(page => { returned = true; return page; });
  try {
    await started.promise; await tick();
    assert.equal(returned, true, 'The native shell must not wait for the detail request');
    const page = await opening, detail = detailNode(page);
    assert.equal(detail.type, 'detail');
    assert.deepEqual(Array.from(detail.children.slice(0, 3), node => node.type), ['toolbar', 'column', 'tabBar']);
    assert.equal(loading(page).type, 'progress');
    assert.equal(loading(page).appearance, 'secondary');
    assert.equal(detail.items[0].type, 'column', 'The aside retains the SDK bounded-column contract');
    assert.equal(nodes(detail.items[0]).find(node => node.id === 'item-details-aside-loading').appearance, 'secondary');
    assert.equal(tabs(page).children[0].value, 'selected');
    assert.ok(tabs(page).children.every(node => node.disabled));
    assert.deepEqual(Array.from(tabs(page).children, node => node.subtitle), ['2', undefined, undefined, undefined]);
    assert.ok(nodes(detail).find(node => node.action === 'handoff-item').disabled);
    assert.ok(!nodes(detail).some(node => node.type === 'textEditor' || node.action?.startsWith('pr-merge:')));
    assert.doesNotMatch(texts(detail), /Complete description/);
  } finally { release.resolve(); }
  await f.waitForInvalidation(notificationsBeforeCompletion);
  const ready = await f.renderReady({});
  assert.ok(!loading(ready));
  assert.match(texts(ready), /Complete description/);
  assert.ok(tabs(ready).children.every(node => !node.disabled));
  assert.ok(f.invalidations.length > notificationsBeforeCompletion, 'Completing the detail must notify the host without another render request');
});

test('Rapid A to B switching never shows the prior title counts or content and late A cannot repaint B', async () => {
  const firstStarted = deferred(), firstRelease = deferred(), secondStarted = deferred(), secondRelease = deferred();
  const f = currentHost({ items: [pull(1, { comments: 19 }), pull(2)], detail: async number => {
    if (number === 1) { firstStarted.resolve(); await firstRelease.promise; return body(pull(1, { body: 'Stale A description', commits: 22 })); }
    secondStarted.resolve(); await secondRelease.promise; return body(pull(2, { body: 'Current B description' }));
  } });
  await list(f);
  try {
    await f.render(select(1)); await firstStarted.promise;
    const next = await f.render(select(2)); await secondStarted.promise;
    assert.equal(next.value, 'item-alice/project/2');
    assert.match(texts(detailNode(next)), /Pull 2/);
    assert.doesNotMatch(texts(detailNode(next)), /Pull 1|Stale A/);
    assert.ok(tabs(next).children.every(node => node.subtitle === undefined));
    const before = f.invalidations.length;
    firstRelease.resolve(); await tick();
    assert.equal(f.invalidations.length, before, 'A stale detail cannot ask the host to repaint');
    const stillLoading = await f.render({});
    assert.equal(stillLoading.value, 'item-alice/project/2');
    assert.ok(loading(stillLoading));
    assert.doesNotMatch(texts(detailNode(stillLoading)), /Stale A/);
  } finally { firstRelease.resolve(); secondRelease.resolve(); }
  const ready = await f.renderReady({});
  assert.equal(ready.value, 'item-alice/project/2');
  assert.match(texts(ready), /Current B description/);
  assert.doesNotMatch(texts(ready), /Stale A description/);
});

test('Switching from a loaded PR cannot borrow its tab selection check counts or metadata', async () => {
  const release = deferred();
  const f = currentHost({ detail: async number => number === 1
    ? body(pull(1, { body: 'First description', commits: 8, changed_files: 5, requested_reviewers: [{ login: 'first-reviewer' }] }))
    : (await release.promise, body(pull(2, { body: 'Second description' }))) });
  await list(f); await f.renderReady(select(1)); await f.render({ action: 'pr-tab:files' });
  try {
    const page = await f.render(select(2));
    assert.equal(tabs(page).children.find(node => node.value === 'selected').id, 'pr-tab-discussion');
    assert.ok(tabs(page).children.every(node => node.subtitle === undefined));
    assert.ok(detailNode(page).items.length, 'The new discussion reserves its own metadata width');
    assert.doesNotMatch(texts(detailNode(page)), /First description|first-reviewer/);
  } finally { release.resolve(); }
  await f.renderReady({});
});

test('A failed detail keeps the native shell and retry returns a new skeleton before recovering', async () => {
  let fail = true;
  const release = deferred();
  const f = currentHost({ detail: async number => fail ? body({}, 403) : (await release.promise, body(pull(number, { body: 'Recovered detail' }))) });
  await list(f);
  const failed = await f.renderReady(select(1));
  assert.equal(detailNode(failed).type, 'detail');
  assert.ok(nodes(failed).some(node => node.action === 'retry-detail'));
  assert.ok(tabs(failed).children.every(node => node.disabled));
  assert.ok(!loading(failed));
  fail = false;
  try {
    const retry = await f.render({ action: 'retry-detail' });
    assert.ok(loading(retry));
    assert.doesNotMatch(texts(retry), /access was denied/);
  } finally { release.resolve(); }
  assert.match(texts(await f.renderReady({})), /Recovered detail/);
  assert.equal(f.writes.length, 0); assert.equal(f.links.length, 0);
});

for (const action of ['close-detail', 'disconnect']) test(`A late detail after ${action} cannot reopen the item or invalidate the host`, async () => {
  const started = deferred(), release = deferred();
  const f = currentHost({ detail: async number => { started.resolve(); await release.promise; return body(pull(number, { body: 'Late private description' })); } });
  await list(f);
  try {
    const pending = await f.render(select(1)); await started.promise;
    assert.ok(loading(pending));
    const page = await f.render({ action });
    assert.ok(!detailNode(page));
    const before = f.invalidations.length;
    release.resolve(); await tick();
    assert.equal(f.invalidations.length, before);
    const current = await f.render({});
    assert.ok(!detailNode(current));
    assert.doesNotMatch(texts(current), /Late private description/);
  } finally { release.resolve(); }
});

test('Refreshing the same PR retains its selected tab and local draft without reserving an unused aside', async () => {
  let refresh = false;
  const release = deferred();
  const f = currentHost({ detail: async number => {
    if (refresh) await release.promise;
    return body(pull(number, { body: refresh ? 'Refreshed description' : 'Original description' }));
  } });
  await list(f);
  const first = await f.renderReady(select(1)), field = nodes(first).find(node => node.type === 'textEditor').id;
  await f.render({ action: 'pr-tab:files', values: { [field]: 'Unfinished local reply' } });
  refresh = true;
  try {
    const pending = await f.render({ action: 'refresh-detail' });
    assert.ok(loading(pending));
    assert.equal(tabs(pending).children.find(node => node.value === 'selected').id, 'pr-tab-files');
    assert.equal(detailNode(pending).items?.length || 0, 0);
  } finally { release.resolve(); }
  const refreshed = await f.renderReady({});
  assert.equal(tabs(refreshed).children.find(node => node.value === 'selected').id, 'pr-tab-files');
  const discussion = await f.render({ action: 'pr-tab:discussion' });
  assert.equal(nodes(discussion).find(node => node.type === 'textEditor').value, 'Unfinished local reply');
  assert.match(texts(discussion), /Refreshed description/);
  assert.equal(f.writes.length, 0);
});

test('Hosts without panel invalidation keep awaited detail loading and do not schedule a background redraw', async () => {
  const started = deferred(), release = deferred();
  const f = currentHost({ supportsPanelInvalidation: false, detail: async number => {
    started.resolve(); await release.promise; return body(pull(number, { body: 'Legacy complete description' }));
  } });
  await list(f);
  let returned = false;
  const opening = f.render(select(1)).then(page => { returned = true; return page; });
  try {
    await started.promise; await tick();
    assert.equal(returned, false);
  } finally { release.resolve(); }
  const page = await opening;
  assert.match(texts(page), /Legacy complete description/);
  assert.ok(!loading(page));
  assert.equal(f.invalidations.length, 0);
});

test('An Issue uses the same immediate skeleton and does not render its list snapshot before fetching details', async () => {
  const release = deferred(), started = deferred();
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([]);
    if (url.pathname === '/search/issues') return searchBody([issue(1, 'Issue title', { body: 'Incomplete feed body' })]);
    started.resolve(); await release.promise; return body(issue(1, 'Issue title', { body: 'Complete issue detail' }));
  } });
  await f.renderReady({});
  try {
    const page = await f.render(select(1)); await started.promise;
    assert.equal(detailNode(page).type, 'detail');
    assert.equal(nodes(page).find(node => node.id === 'issue-tabs').type, 'tabBar');
    assert.ok(loading(page));
    assert.doesNotMatch(texts(detailNode(page)), /Incomplete feed body|Complete issue detail/);
  } finally { release.resolve(); }
  assert.match(texts(await f.renderReady({})), /Complete issue detail/);
});

test('Opening a selection through peek returns a skeleton and closing peek cancels its eventual refresh', async () => {
  const release = deferred(), started = deferred();
  const f = currentHost({ detail: async number => { started.resolve(); await release.promise; return body(pull(number)); } });
  await list(f);
  try {
    const first = await f.render({ action: 'peek-item', value: 'item-alice/project/1' }); await started.promise;
    assert.ok(loading(first));
    const closed = await f.render({ action: 'peek-item', value: 'item-alice/project/1' });
    assert.ok(!detailNode(closed));
    const before = f.invalidations.length;
    release.resolve(); await tick();
    assert.equal(f.invalidations.length, before);
    assert.ok(!detailNode(await f.render({})));
  } finally { release.resolve(); }
});

test('Queued comment and merge actions cannot write through the old model while the same PR refreshes', async () => {
  let refresh = false;
  const started = deferred(), release = deferred();
  const f = currentHost({ detail: async number => {
    if (refresh) { started.resolve(); await release.promise; }
    return body(pull(number));
  } });
  await list(f);
  const first = await f.renderReady(select(1)), field = nodes(first).find(node => node.type === 'textEditor').id;
  await f.render({ values: { [field]: 'A local draft' } });
  refresh = true;
  try {
    await f.render({ action: 'refresh-detail' }); await started.promise;
    for (const action of ['pr-comment', 'pr-merge:squash', 'pr-confirm-merge', 'handoff-item']) await f.render({ action });
    assert.equal(f.drafts.length, 0);
    assert.equal(f.writes.length, 0);
    assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
  } finally { release.resolve(); }
  const page = await f.renderReady({});
  assert.equal(nodes(page).find(node => node.type === 'textEditor').value, 'A local draft');
});
