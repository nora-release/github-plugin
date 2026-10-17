import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, texts, connection, deferred } from './fixtures/plugin-fixture.js';

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
  return fixture({ saved: connection, route: async (url, args) => {
    if (url.pathname === '/search/issues') assert.equal(url.searchParams.get('advanced_search'), 'true');
    return basics(url) || route(url, args);
  } });
}

test('Connected overview searches only personal Issues without selecting or fetching the first repository', async () => {
  const f = feedFixture(async url => {
    assert.equal(url.pathname, '/search/issues');
    assert.deepEqual(Object.fromEntries(url.searchParams), { q: 'is:issue state:open involves:alice', sort: 'updated', order: 'desc', per_page: '50', page: '1', advanced_search: 'true' });
    return searchBody([feedItem('team/second', 17, 'Team issue')]);
  });
  const view = await f.renderReady({});
  assert.match(texts(view), /Team issue/);
  assert.deepEqual(itemActions(view), [`item:${key('team/second', 17)}`]);
  assert.equal(apiRequests(f).length, 3);
  assert.ok(apiRequests(f).every(request => request.headers.Authorization === 'Bearer test_token'));
  assert.ok(!f.requests.some(request => new URL(request.url).pathname.startsWith('/repos/')));
});

test('Issue and PR searches retain distinct repository-number identities and do not mix kinds', async () => {
  const first = feedItem('alice/project', 7, 'First issue');
  const second = feedItem('team/second', 7, 'Second issue', { id: first.id });
  const pull = feedItem('team/second', 8, 'Real pull', { pull_request: {}, draft: true });
  const f = feedFixture(async () => searchBody([first, second, pull]));
  const issues = await f.renderReady({});
  assert.deepEqual(itemActions(issues), [`item:${key('alice/project', 7)}`, `item:${key('team/second', 7)}`]);
  assert.doesNotMatch(texts(issues), /Real pull/);
  const pulls = await f.render({ action: 'kind:pulls' });
  assert.deepEqual(itemActions(pulls), [`item:${key('team/second', 8)}`]);
  assert.doesNotMatch(texts(pulls), /First issue|Second issue/);
  assert.equal(f.requests.filter(request => new URL(request.url).pathname === '/search/issues').length, 2);
});

test('A page with only the other kind retains the server next page and reaches later matching rows', async () => {
  const f = feedFixture(async url => url.searchParams.get('page') === '2'
    ? searchBody([feedItem('team/second', 42, 'Later pull', { pull_request: {} })])
    : searchBody([feedItem('alice/project', 1, 'Other kind')], 200, { link: '<https://api.github.com/search/issues?page=2>; rel="next"' }));
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

test('Personal search pagination deduplicates repository and number rather than inconsistent REST item IDs', async () => {
  const f = feedFixture(async url => url.searchParams.get('page') === '2'
    ? searchBody([feedItem('alice/project', 1, 'Updated', { id: 900 }), feedItem('team/second', 1, 'Distinct')])
    : searchBody([feedItem('alice/project', 1, 'Earlier')], 200, { Link: '<https://api.github.com/search/issues?page=2>; rel="next"' }));
  await f.renderReady({});
  const view = await f.render({ action: 'more-items' });
  assert.deepEqual(itemActions(view), [`item:${key('alice/project', 1)}`, `item:${key('team/second', 1)}`]);
  assert.match(texts(view), /Updated|Distinct/);
  assert.doesNotMatch(texts(view), /Earlier/);
});

test('Personal queries exclude unrelated public repository activity and include PR review involvement', async () => {
  const unrelated = feedItem('vitest-dev/vitest', 11594, 'Unrelated public pull request', { pull_request: {} });
  const relevant = feedItem('vitest-dev/docs-cn', 28, 'Review requested from Alice', { pull_request: {}, user: { login: 'contributor' } });
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo('vitest-dev/docs-cn')]);
    assert.equal(url.searchParams.get('advanced_search'), 'true');
    assert.equal(url.pathname, '/search/issues', 'Public access must not trigger the broad /issues or repository-list endpoints.');
    const query = url.searchParams.get('q');
    if (query.startsWith('is:issue ')) {
      assert.equal(query, 'is:issue state:open involves:alice');
      return searchBody([]);
    }
    assert.equal(query, 'is:pull-request state:open (involves:alice OR review-involves:alice)');
    return searchBody([relevant]);
  } });
  assert.deepEqual(itemActions(await f.renderReady({})), []);
  const pulls = await f.render({ action: 'kind:pulls' });
  assert.deepEqual(itemActions(pulls), [`item:${key('vitest-dev/docs-cn', 28)}`]);
  assert.match(texts(pulls), /Review requested from Alice/);
  assert.doesNotMatch(texts(pulls), new RegExp(unrelated.title));
  assert.ok(apiRequests(f).every(request => !new URL(request.url).searchParams.has('filter')));
});

test('Personal scope survives pagination, repository selection, status changes, and Issue/PR switches', async () => {
  const queries = [];
  const f = feedFixture(async url => {
    assert.equal(url.pathname, '/search/issues');
    const query = url.searchParams.get('q'), page = url.searchParams.get('page');
    queries.push({ query, page });
    assert.deepEqual(Object.fromEntries([...url.searchParams].filter(([name]) => name !== 'q' && name !== 'page')),
      { sort: 'updated', order: 'desc', per_page: '50', advanced_search: 'true' });
    const isPull = query.startsWith('is:pull-request ');
    return searchBody([feedItem(query.includes('repo:team/second') ? 'team/second' : 'alice/project', Number(page), `Page ${page}`,
      isPull ? { pull_request: {} } : {})], 200, page === '1' ? { link: '<https://api.github.com/search/issues?page=2>; rel="next"' } : {});
  });
  await f.renderReady({});
  await f.render({ action: 'more-items' });
  await f.render({ action: 'repository', value: 'team/second' });
  await f.render({ action: 'status', value: 'closed' });
  await f.render({ action: 'kind:pulls' });
  await f.render({ action: 'more-items' });
  await f.render({ action: 'status', value: 'all' });
  await f.render({ action: 'repository', value: '' });
  await f.render({ action: 'kind:issues' });
  assert.deepEqual(queries, [
    { query: 'is:issue state:open involves:alice', page: '1' },
    { query: 'is:issue state:open involves:alice', page: '2' },
    { query: 'is:issue state:open repo:team/second involves:alice', page: '1' },
    { query: 'is:issue state:closed repo:team/second involves:alice', page: '1' },
    { query: 'is:pull-request state:closed repo:team/second (involves:alice OR review-involves:alice)', page: '1' },
    { query: 'is:pull-request state:closed repo:team/second (involves:alice OR review-involves:alice)', page: '2' },
    { query: 'is:pull-request repo:team/second (involves:alice OR review-involves:alice)', page: '1' },
    { query: 'is:pull-request (involves:alice OR review-involves:alice)', page: '1' },
    { query: 'is:issue involves:alice', page: '1' },
  ]);
});

test('Malformed or incomplete search metadata is rejected without falling back to an unscoped feed', async () => {
  const entry = feedItem('alice/project', 1, 'Must not be rendered');
  const invalid = [
    null,
    [entry],
    { items: [entry], total_count: 1 },
    { items: [entry], total_count: 1, incomplete_results: 'false' },
    { items: [entry], total_count: 1, incomplete_results: true },
    { items: [entry], total_count: -1, incomplete_results: false },
    { items: [entry], total_count: 1.1, incomplete_results: false },
    { items: [entry], total_count: Number.MAX_SAFE_INTEGER + 1, incomplete_results: false },
    { items: [entry], total_count: '1', incomplete_results: false },
    { items: null, total_count: 1, incomplete_results: false },
    { items: [entry], incomplete_results: false },
  ];
  for (const response of invalid) {
    const f = feedFixture(async url => {
      assert.equal(url.pathname, '/search/issues');
      return body(response);
    });
    const view = await f.renderReady({});
    assert.deepEqual(itemActions(view), []);
    assert.match(texts(view), /invalid|could not finish this search/i);
    assert.doesNotMatch(texts(view), /Must not be rendered/);
    assert.equal(apiRequests(f).filter(request => new URL(request.url).pathname === '/search/issues').length, 1);
    assert.ok(!apiRequests(f).some(request => new URL(request.url).pathname === '/issues'));
  }
});

test('A personal search access or validation error never retries with a broad repository feed', async () => {
  for (const responseStatus of [403, 422, 503]) {
    const f = feedFixture(async url => {
      assert.equal(url.pathname, '/search/issues');
      return body({ message: 'Search unavailable' }, responseStatus);
    });
    const view = await f.renderReady({});
    assert.deepEqual(itemActions(view), []);
    assert.ok(nodes(view).some(node => node.action === 'retry-load'));
    assert.ok(apiRequests(f).every(request => ['/user', '/user/repos', '/search/issues'].includes(new URL(request.url).pathname)));
    assert.equal(apiRequests(f).filter(request => new URL(request.url).pathname === '/search/issues').length, 1);
  }
});

test('Search pagination follows Link rather than a changing count and stops at GitHub’s 1,000-result boundary', async () => {
  const f = feedFixture(async url => {
    assert.equal(url.pathname, '/search/issues');
    const page = Number(url.searchParams.get('page'));
    return body({ items: [feedItem('alice/project', page, `Personal result ${page}`)], total_count: 1, incomplete_results: false },
      200, { Link: `<https://api.github.com/search/issues?page=${page + 1}>; rel="next"` });
  });
  let view = await f.renderReady({});
  for (let page = 2; page <= 20; page++) {
    assert.equal(view.children[0].loadMoreAction, 'more-items');
    view = await f.render({ action: 'more-items' });
  }
  assert.equal(view.children[0].loadMoreAction, undefined);
  assert.equal(view.children[0].loadMoreToken, undefined);
  const before = f.requests.length;
  await f.render({ action: 'more-items' });
  assert.equal(f.requests.length, before);
  assert.equal(apiRequests(f).filter(request => new URL(request.url).pathname === '/search/issues').length, 20);
  assert.equal(itemActions(view).length, 20);
});

test('Unsafe account logins cannot inject search operators or issue an unscoped request', async () => {
  for (const login of ['', 'alice OR is:public', 'alice\nrepo:vitest-dev/vitest', 'a:b', 'a/b', 'a'.repeat(101), '-alice', '_alice']) {
    const f = fixture({ saved: connection, route: async url => {
      if (url.pathname === '/user') return body({ login });
      if (url.pathname === '/user/repos') return body([]);
      return assert.fail(`Invalid account must fail before searching: ${url}`);
    } });
    const view = await f.renderReady({});
    assert.deepEqual(itemActions(view), []);
    assert.match(texts(view), /invalid/i);
    assert.ok(apiRequests(f).every(request => ['/user', '/user/repos'].includes(new URL(request.url).pathname)));
    assert.ok(!apiRequests(f).some(request => new URL(request.url).pathname === '/search/issues'));
  }
  for (const login of ['alice', 'Alice-Enterprise_team']) {
    const f = fixture({ saved: connection, route: async url => {
      if (url.pathname === '/user') return body({ login });
      if (url.pathname === '/user/repos') return body([]);
      assert.equal(url.pathname, '/search/issues');
      assert.equal(url.searchParams.get('advanced_search'), 'true');
      assert.equal(url.searchParams.get('q'), `is:issue state:open involves:${login}`);
      return searchBody([]);
    } });
    await f.renderReady({});
    assert.equal(apiRequests(f).filter(request => new URL(request.url).pathname === '/search/issues').length, 1);
  }
});

test('Selecting a cross-repository Issue reads its repository detail and keeps stable identity', async () => {
  const item = feedItem('team/second', 7, 'Summary', { body: 'List body' });
  const f = feedFixture(async url => url.pathname === '/search/issues' ? searchBody([item])
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
  const f = feedFixture(async url => url.pathname === '/search/issues' ? searchBody([item])
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
  const f = feedFixture(async url => url.pathname === '/search/issues' ? searchBody([first, second]) : body(second));
  await f.renderReady({});
  const before = f.requests.length;
  await f.render({ action: 'item:7' });
  assert.equal(f.requests.length, before);
  const selected = await f.render({ action: `item:${key('team/second', 7)}` });
  assert.equal(selected.value, key('team/second', 7));
});

test('Personal search repository identities require a real API repository URL or matching full name', async () => {
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
    const f = feedFixture(async () => searchBody([feedItem('alice/project', 1, 'Unsafe entry', extra)]));
    const view = await f.renderReady({});
    assert.ok(!itemActions(view).length);
    assert.match(texts(view), /invalid|owner\/name/i);
    assert.ok(!f.requests.some(request => new URL(request.url).pathname.startsWith('/repos/')));
  }
  const valid = feedFixture(async () => searchBody([issue(1, 'Explicit full name', { repository_url: undefined, repository: { full_name: 'team/second' } })]));
  assert.deepEqual(itemActions(await valid.renderReady({})), [`item:${key('team/second', 1)}`]);
});

test('The longest permitted repository and safe item number remain within SDK identity and action limits', async () => {
  const repository = `alice/${'x'.repeat(194)}`;
  const number = Number.MAX_SAFE_INTEGER;
  const f = feedFixture(async () => searchBody([feedItem(repository, number, 'Bounded identity')]));
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
    if (url.pathname === '/search/issues') return searchBody([first, second]);
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
    if (url.pathname === '/search/issues') return searchBody([item, pull]);
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
    if (url.pathname === '/search/issues') return searchBody([feedItem('alice/project', 1, 'First'), feedItem('team/second', 2, 'Second')]);
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

test('Repository selection adds a repository qualifier without broadening the personal search', async () => {
  const f = feedFixture(async url => {
    assert.equal(url.pathname, '/search/issues');
    const query = url.searchParams.get('q');
    assert.match(query, /(?:^| )involves:alice(?: |$)/);
    if (query.includes('repo:team/second')) return searchBody([feedItem('team/second', 7, 'Filtered item')]);
    assert.doesNotMatch(query, /repo:/);
    return searchBody([feedItem('alice/project', 8, 'Personal item')]);
  });
  await f.renderReady({});
  assert.deepEqual(itemActions(await f.render({ action: 'repository', value: 'team/second' })), [`item:${key('team/second', 7)}`]);
  assert.deepEqual(itemActions(await f.render({ action: 'repository', value: '' })), [`item:${key('alice/project', 8)}`]);
  assert.ok(apiRequests(f).filter(request => !['/user', '/user/repos'].includes(new URL(request.url).pathname))
    .every(request => new URL(request.url).pathname === '/search/issues'));
});

test('Refreshing the overview reloads one personal search independently of the repository picker', async () => {
  const f = feedFixture(async url => {
    assert.equal(url.pathname, '/search/issues');
    return searchBody([feedItem('team/second', 1, 'Fresh issue')]);
  });
  await f.renderReady({});
  await f.render({ action: 'refresh' });
  assert.equal(f.requests.filter(request => new URL(request.url).pathname === '/search/issues').length, 2);
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
    if (url.pathname === '/search/issues') {
      assert.equal(url.searchParams.get('q'), `is:issue state:open involves:${isNew ? 'bob' : 'alice'}`);
      assert.equal(url.searchParams.get('advanced_search'), 'true');
      return searchBody([isNew ? second : first]);
    }
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
  const f = feedFixture(async url => url.pathname === '/search/issues' ? searchBody([item]) : failures ? body({}, 403) : body({ ...item, body: 'Recovered complete details' }));
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
    const f = feedFixture(async url => url.pathname === '/search/issues' ? searchBody([feedItem('team/second', 3, 'Selected source')]) : body(detail));
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
    if (url.pathname === '/search/issues') return searchBody([item]);
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
