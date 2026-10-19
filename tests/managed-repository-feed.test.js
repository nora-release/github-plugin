import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, texts, connection, deferred } from './fixtures/plugin-fixture.js';

const pullPrefix = 'is:pull-request state:open archived:false';
const incoming = (repository, number, title, extra = {}) => issue(number, title, {
  pull_request: {}, user: { login: 'contributor' }, assignees: [], requested_reviewers: [],
  repository_url: `https://api.github.com/repos/${repository}`,
  html_url: `https://github.com/${repository}/pull/${number}`,
  ...extra,
});
const managed = (name, id, extra = {}) => ({ ...repo(name, id), permissions: { push: true, admin: true }, ...extra });
const itemActions = view => nodes(view).filter(node => node.action?.startsWith('item:')).map(node => node.action);
const discoveryRequests = f => f.requests.filter(request => {
  const url = new URL(request.url);
  return url.pathname === '/user/repos' && url.searchParams.has('affiliation');
});
const searchRequests = f => f.requests.filter(request => new URL(request.url).pathname === '/search/issues');
const pullQueries = f => searchRequests(f).map(request => new URL(request.url).searchParams.get('q')).filter(query => query.startsWith('is:pull-request '));
const assertOverview = (query, login, repositories) => {
  const personal = `(involves:${login} OR review-involves:${login} OR user:${login}`;
  assert.ok(query.startsWith(`${pullPrefix} ${personal}`));
  assert.ok(query.endsWith(')'));
  const scopes = [...query.matchAll(/\brepo:([^\s)]+)/g)].map(match => match[1].toLowerCase());
  assert.deepEqual([...scopes].sort(), [...repositories].map(name => name.toLowerCase()).sort());
  assert.equal(scopes.length, new Set(scopes).size);
};

function managedFixture(discover, search, options = {}) {
  return fixture({ saved: connection, ...options, route: async (url, args) => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') {
      if (!url.searchParams.has('affiliation')) return body([repo('alice/picker-only')]);
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        affiliation: 'collaborator,organization_member', sort: 'updated', per_page: '100', page: url.searchParams.get('page'),
      });
      return discover(url, args);
    }
    assert.equal(url.pathname, '/search/issues', 'Incoming work uses one scoped search rather than a feed per repository.');
    assert.equal(url.searchParams.get('advanced_search'), 'true');
    assert.equal(url.searchParams.get('sort'), 'updated');
    assert.equal(url.searchParams.get('order'), 'desc');
    assert.equal(url.searchParams.get('per_page'), '50');
    return search(url, args);
  } });
}

test('Incoming scope discovers admin and maintain repositories beyond the first full page while excluding write-only access', async () => {
  const first = [
    ...Array.from({ length: 96 }, (_, index) => managed(`org/readonly-${index}`, index + 1, { permissions: { pull: true, push: false } })),
    managed('alice/personal', 97), managed('org/retired', 98, { archived: true }),
    managed('ORG/WRITABLE', 99), managed('org/writable', 100),
  ];
  assert.equal(first.length, 100);
  const f = managedFixture(async url => url.searchParams.get('page') === '1'
    ? body(first, 200, { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' })
    : body([managed('collaborator/project', 101, { permissions: { push: true, maintain: true, admin: false } }), managed('org/writable', 102),
      managed('org/readonly-extra', 103, { permissions: { pull: true } }), managed('org/retired-later', 104, { archived: true }),
      managed('org/write-only', 105, { permissions: { pull: true, push: true, maintain: false, admin: false } })]),
  async url => {
    const query = url.searchParams.get('q');
    if (query.startsWith('is:issue ')) {
      assert.equal(query, 'is:issue state:open archived:false involves:alice');
      return searchBody([]);
    }
    assertOverview(query, 'alice', ['org/writable', 'collaborator/project']);
    return searchBody([incoming('collaborator/project', 4, 'Incoming beyond the first hundred repositories'),
      incoming('alice/not-in-picker', 9, 'Incoming to a personal repository outside the picker')]);
  });
  await f.renderReady({});
  const view = await f.renderReady({ action: 'kind:pulls' });
  assert.deepEqual(itemActions(view), ['item:item-collaborator/project/4', 'item:item-alice/not-in-picker/9']);
  assert.equal(discoveryRequests(f).length, 2);
  assert.deepEqual(discoveryRequests(f).map(request => new URL(request.url).searchParams.get('page')), ['1', '2']);
  assert.doesNotMatch(pullQueries(f)[0], /readonly|retired|write-only|repo:alice\//i);
});

test('Managed incoming work keeps one server-sorted query and stable scope across feed pages and kind switches', async () => {
  const f = managedFixture(async () => body([managed('org/writable', 1)]), async url => {
    if (url.searchParams.get('q').startsWith('is:issue ')) return searchBody([]);
    assertOverview(url.searchParams.get('q'), 'alice', ['org/writable']);
    return url.searchParams.get('page') === '2'
      ? searchBody([incoming('org/writable', 1, 'Updated incoming fix', { id: 999 }),
        incoming('team/reviewed', 2, 'Review requested from Alice', { requested_reviewers: [{ login: 'alice' }] })])
      : searchBody([incoming('org/writable', 1, 'Initial incoming fix')], 200,
        { Link: '<https://api.github.com/search/issues?page=2>; rel="next"' });
  });
  await f.renderReady({});
  await f.renderReady({ action: 'kind:pulls' });
  const next = await f.renderReady({ action: 'more-items' });
  assert.deepEqual(itemActions(next), ['item:item-org/writable/1', 'item:item-team/reviewed/2']);
  assert.match(texts(next), /Updated incoming fix|Review requested from Alice/);
  assert.doesNotMatch(texts(next), /Initial incoming fix/);
  assert.equal(next.children[0].loadMoreAction, undefined);
  await f.renderReady({ action: 'kind:issues' });
  await f.renderReady({ action: 'kind:pulls' });
  assert.equal(discoveryRequests(f).length, 1);
  assert.equal(new Set(pullQueries(f)).size, 1);
  assert.deepEqual(searchRequests(f).filter(request => new URL(request.url).searchParams.get('q').startsWith('is:pull-request '))
    .map(request => new URL(request.url).searchParams.get('page')), ['1', '2', '1']);
});

test('Selecting an owned or administered repository includes incoming PRs while a write-only repository remains personal', async () => {
  const f = managedFixture(async () => body([managed('org/writable', 1), managed('org/write-only', 2, { permissions: { push: true, pull: true, maintain: false, admin: false } })]),
    async () => searchBody([]));
  await f.renderReady({});
  await f.renderReady({ action: 'kind:pulls' });
  await f.renderReady({ action: 'repository', value: 'ORG/WRITABLE' });
  assert.equal(pullQueries(f).at(-1), `${pullPrefix} repo:ORG/WRITABLE`);
  await f.renderReady({ action: 'repository', value: 'alice/not-in-picker' });
  assert.equal(pullQueries(f).at(-1), `${pullPrefix} repo:alice/not-in-picker`);
  await f.renderReady({ action: 'repository', value: 'org/write-only' });
  assert.equal(pullQueries(f).at(-1), `${pullPrefix} repo:org/write-only (involves:alice OR review-involves:alice)`);
  await f.renderReady({ action: 'kind:issues' });
  assert.equal(new URL(searchRequests(f).at(-1).url).searchParams.get('q'), 'is:issue state:open archived:false repo:org/write-only involves:alice');
});

test('Refreshing repository permissions removes revoked incoming scope and its old rows', async () => {
  let maintained = true;
  const f = managedFixture(async () => body([managed('org/writable', 1, { permissions: { push: true, maintain: maintained, admin: false } })]), async url => {
    const query = url.searchParams.get('q');
    if (query.startsWith('is:issue ')) return searchBody([]);
    assertOverview(query, 'alice', maintained ? ['org/writable'] : []);
    return searchBody(query.includes('repo:org/writable') ? [incoming('org/writable', 1, 'Incoming work before revocation')] : []);
  });
  await f.renderReady({});
  assert.deepEqual(itemActions(await f.renderReady({ action: 'kind:pulls' })), ['item:item-org/writable/1']);
  maintained = false;
  const revoked = await f.renderReady({ action: 'refresh-repos' });
  assert.deepEqual(itemActions(revoked), []);
  assert.doesNotMatch(texts(revoked), /Incoming work before revocation/);
  assertOverview(pullQueries(f).at(-1), 'alice', []);
  assert.equal(discoveryRequests(f).length, 2);
  maintained = true;
  const restored = await f.renderReady({ action: 'refresh' });
  assert.deepEqual(itemActions(restored), ['item:item-org/writable/1']);
  assert.equal(discoveryRequests(f).length, 3);
});

test('An earlier account discovery response cannot add repositories to a new account scope', async () => {
  const started = deferred(), release = deferred();
  const searches = [];
  const f = fixture({ saved: connection, route: async (url, args) => {
    const isNew = args.headers.Authorization === 'Bearer newer_token';
    if (url.pathname === '/user') return body({ login: isNew ? 'bob' : 'alice' });
    if (url.pathname === '/user/repos') {
      if (!url.searchParams.has('affiliation')) return body([]);
      if (isNew) return body([managed('bob-team/current', 2)]);
      started.resolve();
      await release.promise;
      return body([managed('alice-team/stale', 1)]);
    }
    assert.equal(url.pathname, '/search/issues');
    const query = url.searchParams.get('q');
    searches.push({ query, isNew });
    if (query.startsWith('is:pull-request ')) {
      assert.ok(isNew);
      assertOverview(query, 'bob', ['bob-team/current']);
      return searchBody([incoming('bob-team/current', 2, 'Current account incoming work')]);
    }
    return searchBody([]);
  } });
  const old = f.renderReady({});
  await started.promise;
  await f.renderReady({ action: 'connect-token', values: { token: 'newer_token' } });
  const current = await f.renderReady({ action: 'kind:pulls' });
  assert.deepEqual(itemActions(current), ['item:item-bob-team/current/2']);
  release.resolve();
  await old;
  const after = await f.renderReady({});
  assert.deepEqual(itemActions(after), ['item:item-bob-team/current/2']);
  assert.ok(searches.every(search => !search.query.includes('alice-team/stale')));
  assert.doesNotMatch(texts(after), /alice-team|stale/);
});

test('An initial managed scope failure preserves successful Issues and only a PR request exposes its own failure', async () => {
  const f = managedFixture(async () => body({ message: 'Discovery unavailable' }, 503), async url => {
    assert.equal(url.searchParams.get('q'), 'is:issue state:open archived:false involves:alice');
    return searchBody([issue(1, 'Personal issue remains available')]);
  });
  const initial = await f.renderReady({});
  assert.deepEqual(itemActions(initial), ['item:item-alice/project/1']);
  assert.match(texts(initial), /Personal issue remains available/);
  assert.doesNotMatch(texts(initial), /could not be reached|Couldn’t load this view/i);
  assert.equal(discoveryRequests(f).length, 1);
  const failedPulls = await f.renderReady({ action: 'kind:pulls' });
  assert.deepEqual(itemActions(failedPulls), []);
  assert.match(texts(failedPulls), /could not be reached/i);
  assert.ok(nodes(failedPulls).some(node => node.action === 'retry-load'));
  assert.equal(discoveryRequests(f).length, 2);
  assert.equal(searchRequests(f).length, 1);
  assert.equal(pullQueries(f).length, 0);
});

test('A late managed discovery failure during repository refresh cannot cover a newer successful Issues list', async () => {
  const started = deferred(), release = deferred();
  let scans = 0, searches = 0;
  const f = managedFixture(async () => {
    if (++scans === 1) return body([managed('org/maintained', 1)]);
    started.resolve();
    await release.promise;
    return body({ message: 'Old discovery unavailable' }, 503);
  }, async url => {
    assert.equal(url.searchParams.get('q'), 'is:issue state:open archived:false involves:alice');
    return searchBody([issue(++searches, searches === 1 ? 'Original Issues result' : 'New successful Issues result')]);
  });
  await f.renderReady({});
  await f.render({ action: 'refresh-repos' });
  await started.promise;
  const newer = await f.renderReady({ action: 'kind:issues' });
  assert.deepEqual(itemActions(newer), ['item:item-alice/project/2']);
  const before = f.invalidations.length;
  release.resolve();
  await f.waitForInvalidation(before);
  const after = await f.renderReady({});
  assert.deepEqual(itemActions(after), ['item:item-alice/project/2']);
  assert.match(texts(after), /New successful Issues result/);
  assert.doesNotMatch(texts(after), /Original Issues result|could not be reached|Couldn’t load this view/i);
  assert.equal(searchRequests(f).length, 2);
});

test('A late repository picker failure during refresh cannot cover a newer successful Issues list', async () => {
  const started = deferred(), release = deferred();
  let pickerPages = 0, searches = 0;
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') {
      if (url.searchParams.has('affiliation')) return body([managed('org/maintained', 1)]);
      if (++pickerPages === 1) return body([repo('alice/picker-only')]);
      started.resolve();
      await release.promise;
      return body({ message: 'Old picker unavailable' }, 503);
    }
    assert.equal(url.pathname, '/search/issues');
    assert.equal(url.searchParams.get('q'), 'is:issue state:open archived:false involves:alice');
    return searchBody([issue(++searches, searches === 1 ? 'Original Issues result' : 'New successful Issues result')]);
  } });
  await f.renderReady({});
  await f.render({ action: 'refresh-repos' });
  await started.promise;
  const newer = await f.renderReady({ action: 'kind:issues' });
  assert.deepEqual(itemActions(newer), ['item:item-alice/project/2']);
  const before = f.invalidations.length;
  release.resolve();
  await f.waitForInvalidation(before);
  const after = await f.renderReady({});
  assert.deepEqual(itemActions(after), ['item:item-alice/project/2']);
  assert.match(texts(after), /New successful Issues result/);
  assert.doesNotMatch(texts(after), /Original Issues result|could not be reached|Couldn’t load this view/i);
  assert.equal(searchRequests(f).length, 2);
});

test('A failed discovery page cannot issue a partial incoming search and retries from the missing page', async () => {
  let failing = true;
  const f = managedFixture(async url => url.searchParams.get('page') === '1'
    ? body([managed('org/first-page', 1)], 200, { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' })
    : failing ? body({ message: 'Temporary discovery failure' }, 503) : body([managed('org/second-page', 2)]),
  async url => {
    const query = url.searchParams.get('q');
    if (query.startsWith('is:issue ')) return searchBody([]);
    assertOverview(query, 'alice', ['org/first-page', 'org/second-page']);
    return searchBody([incoming('org/second-page', 2, 'Incoming from the recovered page')]);
  });
  await f.renderReady({});
  const failed = await f.renderReady({ action: 'kind:pulls' });
  assert.match(texts(failed), /could not be reached/i);
  assert.deepEqual(itemActions(failed), []);
  assert.equal(pullQueries(f).length, 0);
  failing = false;
  const recovered = await f.renderReady({ action: 'retry-load' });
  assert.deepEqual(itemActions(recovered), ['item:item-org/second-page/2']);
  assert.deepEqual(discoveryRequests(f).map(request => new URL(request.url).searchParams.get('page')), ['1', '2', '2', '2']);
  assert.equal(pullQueries(f).length, 1);
});

test('An oversized managed scope is visible and never silently omits repositories or broadens search', async () => {
  const repositories = Array.from({ length: 60 }, (_, index) => managed(`org/project-${index}-${'x'.repeat(160)}`, index + 1));
  const f = managedFixture(async () => body(repositories), async url => {
    if (url.searchParams.get('q').startsWith('is:issue ')) return searchBody([]);
    assert.equal(url.searchParams.get('q'), `${pullPrefix} repo:${repositories[0].full_name}`);
    return searchBody([incoming(repositories[0].full_name, 1, 'Incoming in the selected repository')]);
  });
  await f.renderReady({});
  const limited = await f.renderReady({ action: 'kind:pulls' });
  assert.match(texts(limited), /scope is too large.*Select a specific repository/s);
  assert.deepEqual(itemActions(limited), []);
  assert.equal(pullQueries(f).length, 0);
  const selected = await f.renderReady({ action: 'repository', value: repositories[0].full_name });
  assert.deepEqual(itemActions(selected), [`item:item-${repositories[0].full_name}/1`]);
  assert.equal(pullQueries(f).length, 1);
});
