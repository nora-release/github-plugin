import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, repo, issue, nodes, texts, connection, deferred } from './fixtures/plugin-fixture.js';

const feedItem = (repository, number, title, extra = {}) => issue(number, title, {
  repository_url: `https://api.github.com/repos/${repository}`,
  html_url: `https://github.com/${repository}/${extra.pull_request ? 'pull' : 'issues'}/${number}`,
  ...extra,
});
const key = (repository, number) => `item-${repository}/${number}`;
const itemActions = view => nodes(view).filter(node => node.action?.startsWith('item:')).map(node => node.action);
const apiRequests = f => f.requests.filter(request => new URL(request.url).hostname === 'api.github.com');
const basics = url => url.pathname === '/user' ? body({ login: 'alice' }) : url.pathname === '/user/repos' ? body([repo('alice/project'), repo('team/second', 2)]) : null;

function feedFixture(route) {
  return fixture({ saved: connection, route: async (url, args) => basics(url) || route(url, args) });
}

test('Connected overview requests one all-repository feed without selecting or fetching the first repository', async () => {
  const f = feedFixture(async url => {
    assert.equal(url.pathname, '/issues');
    assert.deepEqual(Object.fromEntries(url.searchParams), { filter: 'all', state: 'open', sort: 'updated', direction: 'desc', per_page: '50', page: '1' });
    return body([feedItem('team/second', 17, 'Team issue')]);
  });
  const view = await f.renderReady({});
  assert.match(texts(view), /Team issue/);
  assert.deepEqual(itemActions(view), [`item:${key('team/second', 17)}`]);
  assert.equal(apiRequests(f).length, 3);
  assert.ok(apiRequests(f).every(request => request.headers.Authorization === 'Bearer test_token'));
  assert.ok(!f.requests.some(request => new URL(request.url).pathname.startsWith('/repos/')));
});

test('Issues and PRs partition the mixed global response while same-number repositories retain distinct identities', async () => {
  const first = feedItem('alice/project', 7, 'First issue');
  const second = feedItem('team/second', 7, 'Second issue', { id: first.id });
  const pull = feedItem('team/second', 8, 'Real pull', { pull_request: {}, draft: true });
  const f = feedFixture(async () => body([first, second, pull]));
  const issues = await f.renderReady({});
  assert.deepEqual(itemActions(issues), [`item:${key('alice/project', 7)}`, `item:${key('team/second', 7)}`]);
  assert.doesNotMatch(texts(issues), /Real pull/);
  const pulls = await f.render({ action: 'kind:pulls' });
  assert.deepEqual(itemActions(pulls), [`item:${key('team/second', 8)}`]);
  assert.doesNotMatch(texts(pulls), /First issue|Second issue/);
  assert.equal(f.requests.filter(request => new URL(request.url).pathname === '/issues').length, 2);
});

test('A page with only the other kind retains the server next page and reaches later matching rows', async () => {
  const f = feedFixture(async url => url.searchParams.get('page') === '2'
    ? body([feedItem('team/second', 42, 'Later pull', { pull_request: {} })])
    : body([feedItem('alice/project', 1, 'Other kind')], 200, { link: '<https://api.github.com/issues?page=2>; rel="next"' }));
  await f.renderReady({});
  const first = await f.render({ action: 'kind:pulls' });
  assert.equal(itemActions(first).length, 0);
  assert.equal(first.children[0].loadMoreAction, 'more-items');
  assert.ok(first.children[0].loadMoreToken);
  assert.doesNotMatch(texts(first), /No pull requests in this view/);
  const next = await f.render({ action: 'more-items' });
  assert.match(texts(next), /Later pull/);
  assert.equal(next.children[0].loadMoreAction, undefined);
  assert.equal(next.children[0].loadMoreToken, undefined);
  assert.equal(new URL(apiRequests(f).at(-1).url).searchParams.get('page'), '2');
});

test('Global pagination deduplicates repository and number rather than inconsistent REST item IDs', async () => {
  const f = feedFixture(async url => url.searchParams.get('page') === '2'
    ? body([feedItem('alice/project', 1, 'Updated', { id: 900 }), feedItem('team/second', 1, 'Distinct')])
    : body([feedItem('alice/project', 1, 'Earlier')], 200, { Link: '<https://api.github.com/issues?page=2>; rel="next"' }));
  await f.renderReady({});
  const view = await f.render({ action: 'more-items' });
  assert.deepEqual(itemActions(view), [`item:${key('alice/project', 1)}`, `item:${key('team/second', 1)}`]);
  assert.match(texts(view), /Updated|Distinct/);
  assert.doesNotMatch(texts(view), /Earlier/);
});

test('Selecting a cross-repository Issue reads its repository detail and keeps stable identity', async () => {
  const item = feedItem('team/second', 7, 'Summary', { body: 'List body' });
  const f = feedFixture(async url => url.pathname === '/issues' ? body([item])
    : url.pathname === '/repos/team/second/issues/7' ? body({ ...item, id: 777, title: 'Complete issue', body: 'Fetched issue description' })
    : assert.fail(`Unexpected URL: ${url}`));
  await f.renderReady({});
  const view = await f.render({ action: `item:${key('team/second', 7)}` });
  assert.match(texts(view), /Fetched issue description/);
  assert.equal(view.value, key('team/second', 7));
  assert.equal(new URL(apiRequests(f).at(-1).url).pathname, '/repos/team/second/issues/7');
});

test('Selecting a PR uses the pulls detail API even though the feed item used the issue REST ID', async () => {
  const item = feedItem('team/second', 7, 'PR summary', { id: 1000, pull_request: {} });
  const f = feedFixture(async url => url.pathname === '/issues' ? body([item])
    : url.pathname === '/repos/team/second/pulls/7' ? body({ ...item, id: 2000, body: 'Full PR details', merged_at: '2026-10-15T00:00:00Z' })
    : assert.fail(`Unexpected URL: ${url}`));
  await f.renderReady({});
  await f.render({ action: 'kind:pulls' });
  const view = await f.render({ action: `item:${key('team/second', 7)}` });
  assert.match(texts(view), /Full PR details|Merged/);
  assert.equal(view.value, key('team/second', 7));
  assert.equal(f.requests.filter(request => new URL(request.url).pathname === '/repos/team/second/pulls/7').length, 1);
  assert.ok(f.requests.every(request => request.method === 'GET'));
  assert.ok(!f.requests.some(request => new URL(request.url).pathname === '/repos/team/second/issues/7'));
});

test('Legacy numeric selection only resolves when the loaded repository-number identity is unique', async () => {
  const first = feedItem('alice/project', 7, 'First');
  const second = feedItem('team/second', 7, 'Second');
  const f = feedFixture(async url => url.pathname === '/issues' ? body([first, second]) : body(second));
  await f.renderReady({});
  const before = f.requests.length;
  await f.render({ action: 'item:7' });
  assert.equal(f.requests.length, before);
  const selected = await f.render({ action: `item:${key('team/second', 7)}` });
  assert.equal(selected.value, key('team/second', 7));
});

test('Global feed repository identities require a real API repository URL or matching full name', async () => {
  const invalid = [
    { repository_url: 'https://api.github.com.evil.test/repos/alice/project' },
    { repository_url: 'https://api.github.com/repos/alice/project?other=1' },
    { repository_url: 'https://api.github.com/repos/alice/..' },
    { repository_url: `https://api.github.com/repos/alice/${'x'.repeat(257)}` },
    { repository_url: `https://api.github.com/repos/alice/${'x'.repeat(219)}` },
    { repository_url: undefined },
    { repository_url: 'https://api.github.com/repos/alice/project', repository: { full_name: 'team/second' } },
    { repository_url: 'https://api.github.com/repos/alice/project', number: -1 },
    { repository_url: 'https://api.github.com/repos/alice/project', number: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const extra of invalid) {
    const f = feedFixture(async () => body([feedItem('alice/project', 1, 'Unsafe entry', extra)]));
    const view = await f.renderReady({});
    assert.ok(!itemActions(view).length);
    assert.match(texts(view), /invalid|owner\/name/i);
    assert.ok(!f.requests.some(request => new URL(request.url).pathname.startsWith('/repos/')));
  }
  const valid = feedFixture(async () => body([issue(1, 'Explicit full name', { repository_url: undefined, repository: { full_name: 'team/second' } })]));
  assert.deepEqual(itemActions(await valid.renderReady({})), [`item:${key('team/second', 1)}`]);
});

test('The longest permitted repository and safe item number remain within SDK identity and action limits', async () => {
  const repository = `alice/${'x'.repeat(194)}`;
  const number = Number.MAX_SAFE_INTEGER;
  const f = feedFixture(async () => body([feedItem(repository, number, 'Bounded identity')]));
  const view = await f.renderReady({});
  const entry = nodes(view).find(node => node.action === `item:${key(repository, number)}`);
  assert.ok(entry);
  assert.equal(entry.id.length, 222);
  assert.equal(entry.action.length, 227);
  assert.match(texts(view), /Bounded identity/);
});

test('Late detail responses cannot replace a newer selection with the same number in another repository', async () => {
  const started = deferred(), release = deferred();
  const first = feedItem('alice/project', 7, 'First');
  const second = feedItem('team/second', 7, 'Second');
  const f = feedFixture(async url => {
    if (url.pathname === '/issues') return body([first, second]);
    if (url.pathname === '/repos/alice/project/issues/7') { started.resolve(); await release.promise; return body({ ...first, body: 'Late old details' }); }
    return body({ ...second, body: 'Current second details' });
  });
  await f.renderReady({});
  const old = f.render({ action: `item:${key('alice/project', 7)}` });
  await started.promise;
  await f.render({ action: `item:${key('team/second', 7)}` });
  release.resolve();
  const view = await old;
  assert.equal(view.value, key('team/second', 7));
  assert.match(texts(view), /Current second details/);
  assert.doesNotMatch(texts(view), /Late old details/);
});

test('Switching Issues to PRs during a delayed detail failure clears the old selected item and its error', async () => {
  const started = deferred(), release = deferred();
  const item = feedItem('alice/project', 1, 'Issue');
  const pull = feedItem('team/second', 2, 'Pull', { pull_request: {} });
  const f = feedFixture(async url => {
    if (url.pathname === '/issues') return body([item, pull]);
    started.resolve(); await release.promise; return body({}, 403);
  });
  await f.renderReady({});
  const old = f.render({ action: `item:${key('alice/project', 1)}` });
  await started.promise;
  await f.render({ action: 'kind:pulls' });
  release.resolve();
  const view = await old;
  assert.deepEqual(itemActions(view), [`item:${key('team/second', 2)}`]);
  assert.doesNotMatch(texts(view), /access was denied/);
  assert.ok(!view.value);
});

test('A local search hiding the selected item prevents a pending detail from reopening it', async () => {
  const started = deferred(), release = deferred();
  const f = feedFixture(async url => {
    if (url.pathname === '/issues') return body([feedItem('alice/project', 1, 'First'), feedItem('team/second', 2, 'Second')]);
    started.resolve(); await release.promise; return body(feedItem('alice/project', 1, 'First', { body: 'Hidden late detail' }));
  });
  await f.renderReady({});
  const old = f.render({ action: `item:${key('alice/project', 1)}` });
  await started.promise;
  const before = f.requests.length;
  await f.render({ action: 'query', values: { query: 'Second' } });
  assert.equal(f.requests.length, before);
  release.resolve();
  const view = await old;
  assert.ok(!view.value);
  assert.doesNotMatch(texts(view), /Hidden late detail/);
});

test('A repository filter requests that repository and selecting all repositories returns to the global endpoint', async () => {
  const f = feedFixture(async url => {
    if (url.pathname === '/repos/team/second/issues') return body([issue(7, 'Filtered item', { repository_url: undefined })]);
    assert.equal(url.pathname, '/issues');
    return body([feedItem('alice/project', 8, 'Global item')]);
  });
  await f.renderReady({});
  assert.deepEqual(itemActions(await f.render({ action: 'repository', value: 'team/second' })), [`item:${key('team/second', 7)}`]);
  assert.deepEqual(itemActions(await f.render({ action: 'repository', value: '' })), [`item:${key('alice/project', 8)}`]);
  assert.equal(new URL(f.requests.at(-1).url).pathname, '/issues');
});

test('Refreshing the overview reloads one global item feed independently of the repository picker', async () => {
  const f = feedFixture(async url => {
    assert.equal(url.pathname, '/issues');
    return body([feedItem('team/second', 1, 'Fresh issue')]);
  });
  await f.renderReady({});
  await f.render({ action: 'refresh' });
  assert.equal(f.requests.filter(request => new URL(request.url).pathname === '/issues').length, 2);
  assert.equal(f.requests.filter(request => new URL(request.url).pathname === '/user/repos').length, 2);
  assert.ok(!f.requests.some(request => new URL(request.url).pathname.startsWith('/repos/')));
});

test('Issue and PR commands keep their explicit-repository API and validation contract', async () => {
  const f = fixture({ saved: connection, route: async url => {
    assert.match(url.pathname, /^\/repos\/team\/second\/(issues|pulls)$/);
    return body([issue(1, 'Issue'), issue(2, 'Pull', { pull_request: {} })], 200, { link: '<https://api.github.com/next>; rel="next"' });
  } });
  const issues = await f.command('listIssues', { repository: 'team/second', page: 2, state: 'closed' });
  assert.deepEqual(Array.from(issues.items, item => item.number), [1]);
  assert.equal(issues.nextPage, 3);
  const pulls = await f.command('listPullRequests', { repository: 'team/second' });
  assert.equal(pulls.items.length, 2);
  const count = f.requests.length;
  await assert.rejects(f.command('listIssues', {}), /owner\/name/);
  await assert.rejects(f.command('listIssues', { repository: 'team/second', page: 0 }), /Invalid page/);
  assert.equal(f.requests.length, count);
});

test('Changing the connected account cannot restore an earlier account detail response', async () => {
  const started = deferred(), release = deferred();
  const first = feedItem('alice/project', 1, 'Old account item');
  const second = feedItem('bob/project', 2, 'New account item');
  const f = fixture({ saved: connection, route: async (url, args) => {
    const isNew = args.headers.Authorization === 'Bearer newer_token';
    if (url.pathname === '/user') return body({ login: isNew ? 'bob' : 'alice' });
    if (url.pathname === '/user/repos') return body([repo(isNew ? 'bob/project' : 'alice/project')]);
    if (url.pathname === '/issues') return body([isNew ? second : first]);
    if (url.pathname === '/repos/alice/project/issues/1') { started.resolve(); await release.promise; return body({ ...first, body: 'Previous account details' }); }
    return assert.fail(`Unexpected URL: ${url}`);
  } });
  await f.renderReady({});
  const old = f.render({ action: `item:${key('alice/project', 1)}` });
  await started.promise;
  await f.render({ action: 'connect-token', values: { token: 'newer_token' } });
  release.resolve();
  const view = await old;
  assert.match(texts(view), /bob|New account item/);
  assert.doesNotMatch(texts(view), /Previous account details|Old account item/);
  assert.ok(!view.value);
});

test('A detail error exposes retry and prevents handing an unfetched list snapshot to Nora', async () => {
  let failures = true;
  const item = feedItem('team/second', 3, 'Source item', { body: 'Incomplete list snapshot' });
  const f = feedFixture(async url => url.pathname === '/issues' ? body([item]) : failures ? body({}, 403) : body({ ...item, body: 'Recovered complete details' }));
  await f.renderReady({});
  const failed = await f.render({ action: `item:${key('team/second', 3)}` });
  assert.match(texts(failed), /access was denied/);
  assert.ok(nodes(failed).some(node => node.action === 'retry-detail'));
  await f.render({ action: 'handoff-item' });
  assert.equal(f.drafts.length, 0);
  failures = false;
  const recovered = await f.render({ action: 'retry-detail' });
  assert.match(texts(recovered), /Recovered complete details/);
  assert.doesNotMatch(texts(recovered), /access was denied/);
  await f.render({ action: 'handoff-item' });
  assert.equal(f.drafts.length, 1);
  assert.match(f.drafts[0].context, /Repository: team\/second/);
  assert.match(f.drafts[0].context, /Recovered complete details/);
});

test('A detail response for a different number or repository is rejected without substituting the wrong source', async () => {
  for (const detail of [feedItem('team/second', 99, 'Wrong number'), feedItem('attacker/project', 3, 'Wrong repo')]) {
    const f = feedFixture(async url => url.pathname === '/issues' ? body([feedItem('team/second', 3, 'Selected source')]) : body(detail));
    await f.renderReady({});
    const view = await f.render({ action: `item:${key('team/second', 3)}` });
    assert.match(texts(view), /invalid response/);
    assert.doesNotMatch(texts(view), /Wrong number|Wrong repo/);
    await f.render({ action: 'handoff-item' });
    assert.equal(f.drafts.length, 0);
  }
});

test('Closing a detail during its request clears selection and a late response cannot reopen it', async () => {
  const started = deferred(), release = deferred();
  const item = feedItem('team/second', 3, 'Closable issue');
  const f = feedFixture(async url => {
    if (url.pathname === '/issues') return body([item]);
    started.resolve(); await release.promise; return body({ ...item, body: 'Late closed detail' });
  });
  await f.renderReady({});
  const opening = f.render({ action: `item:${key('team/second', 3)}` });
  await started.promise;
  await f.render({ action: 'close-detail' });
  release.resolve();
  const view = await opening;
  assert.ok(!view.value);
  assert.doesNotMatch(texts(view), /Late closed detail/);
  await f.render({ action: 'handoff-item' });
  assert.equal(f.drafts.length, 0);
});
