import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, texts, connection, deferred } from './fixtures/plugin-fixture.js';

const head = 'a'.repeat(40);
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const tick = () => new Promise(resolve => setImmediate(resolve));
const work = (kind, number, title) => issue(number, title, {
  repository: { full_name: 'team/project' }, repository_url: 'https://api.github.com/repos/team/project',
  html_url: `https://github.com/team/project/${kind === 'pulls' ? 'pull' : 'issues'}/${number}`,
  ...(kind === 'pulls' ? { pull_request: {}, head: { ref: 'feature', sha: head }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean' } : {}),
});
const sidebar = page => nodes(page).find(node => node.type === 'sidebar');
const transitionKey = page => sidebar(page)?.contentTransitionKey;
const rows = page => Array.from(sidebar(page)?.items || [], node => node.text);
const isLoading = page => nodes(page).some(node => node.id === 'github-items-loading');
function transitionFixture(search, options = {}) {
  return fixture({ saved: connection, supportsSidebarContentTransition: true, ...options, route: async (url, args) => {
    if (url.pathname === '/user') return body({ login: 'viewer' });
    if (url.pathname === '/user/repos') return body([repo('team/project')]);
    if (url.pathname === '/search/issues') {
      const kind = url.searchParams.get('q').startsWith('is:pull-request ') ? 'pulls' : 'issues';
      return search(kind, url, args);
    }
    const selected = /^\/repos\/team\/project\/(issues|pulls)\/(\d+)$/.exec(url.pathname);
    if (selected) return body(work(selected[1], Number(selected[2]), `Selected ${selected[1]} ${selected[2]}`));
    if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: false } });
    if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
    if (url.pathname.endsWith('/status')) return body({ statuses: [] });
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
    return body([]);
  } });
}

test('Switching kinds returns loading immediately and changes the sidebar key only when the new rows commit', async () => {
  const started = deferred(), release = deferred();
  const f = transitionFixture(async kind => {
    if (kind === 'issues') return searchBody([work(kind, 1, 'Previous Issue row')]);
    started.resolve(); await release.promise;
    return searchBody([work(kind, 2, 'New PR row')]);
  });
  const initial = await f.renderReady({});
  assert.equal(transitionKey(initial), 'issues');
  assert.deepEqual(rows(initial), ['Previous Issue row']);
  let returned = false;
  const switching = f.render({ action: 'kind:pulls' }).then(page => { returned = true; return page; });
  try {
    await started.promise; await tick();
    assert.equal(returned, true, 'The host can display loading before GitHub finishes.');
    const loading = await switching;
    assert.ok(isLoading(loading));
    assert.equal(transitionKey(loading), 'issues');
    assert.deepEqual(rows(loading), []);
    assert.doesNotMatch(texts(loading), /Previous Issue row/);
  } finally { release.resolve(); }
  const ready = await f.renderReady({});
  assert.equal(transitionKey(ready), 'pulls');
  assert.deepEqual(rows(ready), ['New PR row']);
  assert.equal(transitionKey(await f.render({})), 'pulls');
  assert.ok(!isLoading(ready));
});

test('Interleaved late Issue and PR responses cannot replace the latest sidebar rows or transition key', async () => {
  const oldPullStarted = deferred(), oldPullRelease = deferred(), oldIssueStarted = deferred(), oldIssueRelease = deferred();
  let issueReads = 0, pullReads = 0;
  const f = transitionFixture(async kind => {
    if (kind === 'issues' && ++issueReads === 1) return searchBody([work(kind, 1, 'Initial Issue')]);
    if (kind === 'issues') {
      oldIssueStarted.resolve(); await oldIssueRelease.promise;
      return searchBody([work(kind, 2, 'Late Issue')]);
    }
    if (++pullReads === 1) {
      oldPullStarted.resolve(); await oldPullRelease.promise;
      return searchBody([work(kind, 3, 'Late PR')]);
    }
    return searchBody([work(kind, 4, 'Current PR')]);
  });
  await f.renderReady({});
  try {
    await f.render({ action: 'kind:pulls' }); await oldPullStarted.promise;
    const issueLoading = await f.render({ action: 'kind:issues' }); await oldIssueStarted.promise;
    assert.equal(transitionKey(issueLoading), 'issues');
    assert.deepEqual(rows(issueLoading), []);
    const current = await f.renderReady({ action: 'kind:pulls' });
    assert.equal(transitionKey(current), 'pulls');
    assert.deepEqual(rows(current), ['Current PR']);
    const before = f.invalidations.length;
    oldIssueRelease.resolve(); oldPullRelease.resolve();
    await tick(); await tick();
    const after = await f.renderReady({});
    assert.equal(transitionKey(after), 'pulls');
    assert.deepEqual(rows(after), ['Current PR']);
    assert.equal(f.invalidations.length, before, 'Stale requests cannot ask the host to animate again.');
  } finally { oldIssueRelease.resolve(); oldPullRelease.resolve(); }
});

test('Pagination filtering refresh and delayed avatars do not change the committed kind key', async () => {
  const avatarStarted = deferred(), avatarRelease = deferred();
  const f = transitionFixture(async (kind, url) => kind === 'issues' ? searchBody([work(kind, 1, 'Issue')])
    : url.searchParams.get('page') === '2' ? searchBody([work(kind, 3, 'Later PR')])
      : searchBody([work(kind, 2, 'Current PR')], 200, { Link: '<https://api.github.com/search/issues?page=2>; rel="next"' }),
  { ownerAvatarRoute: async () => { avatarStarted.resolve(); await avatarRelease.promise;
    return { status: 200, headers: { 'content-type': 'image/png' }, bodyBase64: image }; } });
  try {
    await f.renderReady({}); await avatarStarted.promise;
    assert.equal(transitionKey(await f.renderReady({ action: 'kind:pulls' })), 'pulls');
    const next = await f.renderReady({ action: 'more-items' });
    assert.deepEqual(rows(next), ['Current PR', 'Later PR']);
    assert.equal(transitionKey(next), 'pulls');
    const requestCount = f.requests.length;
    const filtered = await f.render({ action: 'query', value: 'Later' });
    assert.deepEqual(rows(filtered), ['Later PR']);
    assert.equal(transitionKey(filtered), 'pulls');
    assert.equal(f.requests.length, requestCount);
    assert.equal(transitionKey(await f.render({ action: 'clear-filters' })), 'pulls');
    const refreshing = await f.render({ action: 'refresh' });
    assert.equal(transitionKey(refreshing), 'pulls');
    const refreshed = await f.renderReady({});
    assert.deepEqual(rows(refreshed), ['Current PR']);
    assert.equal(transitionKey(refreshed), 'pulls');
    const before = f.invalidations.length;
    avatarRelease.resolve();
    await f.waitForInvalidation(before);
    const painted = await f.render({});
    assert.equal(sidebar(painted).items[0].avatarBase64, image);
    assert.equal(transitionKey(painted), 'pulls');
  } finally { avatarRelease.resolve(); }
});

test('Failed kind loads retain the old key while a successful empty retry commits the requested kind', async () => {
  let failed = true;
  const f = transitionFixture(async kind => kind === 'issues' ? searchBody([work(kind, 1, 'Previous Issue')])
    : failed ? body({ message: 'Temporary failure' }, 503) : searchBody([]));
  await f.renderReady({});
  const failure = await f.renderReady({ action: 'kind:pulls' });
  assert.equal(transitionKey(failure), 'issues');
  assert.deepEqual(rows(failure), []);
  assert.match(texts(failure), /could not be reached/i);
  failed = false;
  const empty = await f.renderReady({ action: 'retry-load' });
  assert.equal(transitionKey(empty), 'pulls');
  assert.deepEqual(rows(empty), []);
  assert.doesNotMatch(texts(empty), /could not be reached/i);
  assert.match(texts(empty), /No open pull requests|No pull requests in this view/);
});

test('Hosts without an exact true transition feature receive no content transition property', async () => {
  for (const feature of [undefined, false, 'true', 1]) {
    const f = transitionFixture(async kind => searchBody([work(kind, 1, `A ${kind} row`)]), { supportsSidebarContentTransition: feature });
    assert.equal(Object.hasOwn(sidebar(await f.renderReady({})), 'contentTransitionKey'), false);
    const loading = await f.render({ action: 'kind:pulls' });
    assert.equal(Object.hasOwn(sidebar(loading), 'contentTransitionKey'), false);
    const ready = await f.renderReady({});
    assert.equal(Object.hasOwn(sidebar(ready), 'contentTransitionKey'), false);
    assert.deepEqual(rows(ready), ['A pulls row']);
  }
});

test('Hosts without panel invalidation keep awaiting the new rows rather than returning an unrefreshable loading state', async () => {
  const started = deferred(), release = deferred();
  const f = transitionFixture(async kind => {
    if (kind === 'issues') return searchBody([work(kind, 1, 'Issue')]);
    started.resolve(); await release.promise;
    return searchBody([work(kind, 2, 'PR')]);
  }, { supportsPanelInvalidation: false });
  await f.renderReady({});
  let returned = false;
  const switching = f.render({ action: 'kind:pulls' }).then(page => { returned = true; return page; });
  try {
    await started.promise; await tick();
    assert.equal(returned, false);
  } finally { release.resolve(); }
  const ready = await switching;
  assert.equal(transitionKey(ready), 'pulls');
  assert.deepEqual(rows(ready), ['PR']);
  assert.ok(!isLoading(ready));
});

test('A kind switch clears the old selection and cannot attach a PR draft to the next Issue or PR', async () => {
  const started = deferred(), release = deferred();
  let issueReads = 0;
  const f = transitionFixture(async kind => {
    if (kind === 'pulls') return searchBody([work(kind, 2, 'PR with a draft')]);
    if (++issueReads > 1) { started.resolve(); await release.promise; }
    return searchBody([work(kind, 1, 'Current Issue')]);
  });
  await f.renderReady({}); await f.renderReady({ action: 'kind:pulls' });
  const opened = await f.renderReady({ action: 'item:item-team/project/2' });
  const editor = nodes(opened).find(node => node.type === 'textEditor');
  const draft = 'This draft belongs to the selected PR.';
  await f.render({ action: 'pr-tab:discussion', values: { [editor.id]: draft } });
  try {
    const loading = await f.render({ action: 'kind:issues', values: { [editor.id]: draft } });
    await started.promise;
    assert.equal(sidebar(loading).value, '');
    assert.equal(transitionKey(loading), 'pulls');
    assert.ok(!nodes(loading).some(node => node.id === 'item-details' || node.type === 'textEditor'));
  } finally { release.resolve(); }
  const issues = await f.renderReady({});
  assert.equal(transitionKey(issues), 'issues');
  assert.equal(sidebar(issues).value, '');
  assert.doesNotMatch(texts(issues), /This draft belongs/);
  await f.renderReady({ action: 'item:item-team/project/1' });
  const backToPulls = await f.renderReady({ action: 'kind:pulls' });
  assert.equal(sidebar(backToPulls).value, '');
  assert.ok(!nodes(backToPulls).some(node => node.type === 'textEditor'));
  assert.equal(f.writes.length, 0);
  assert.equal(f.drafts.length, 0);
});
