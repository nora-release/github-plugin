import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, texts, connection, deferred } from './fixtures/plugin-fixture.js';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const avatar = (bodyBase64 = image, contentType = 'image/png') => ({ status: 200, headers: { 'Content-Type': contentType }, bodyBase64 });
const feedItem = (name, number, extra = {}) => issue(number, `Work item ${number}`, {
  repository: { full_name: name }, repository_url: `https://api.github.com/repos/${name}`,
  html_url: `https://github.com/${name}/issues/${number}`, ...extra,
});
const basics = url => url.pathname === '/user' ? body({ login: 'alice' }) : url.pathname === '/user/repos' ? body([]) : null;
const next = { link: '<https://api.github.com/search/issues?page=2>; rel="next"' };
const apiRequests = f => f.requests.filter(request => new URL(request.url).hostname === 'api.github.com');
const renderWithAvatars = async (f, event = {}) => {
  await f.renderReady(event);
  await new Promise(resolve => setImmediate(resolve));
  return f.renderReady({});
};

test('Sidebar rows show the repository owner avatar and separate work state rather than the author avatar', async () => {
  const f = fixture({ saved: connection, ownerAvatarRoute: async (url, args) => {
    assert.equal(url.pathname, '/u/100');
    assert.equal(url.searchParams.get('s'), '64');
    assert.equal(args.maximumResponseBytes, 8 * 1024);
    assert.equal(args.timeoutSeconds, 3);
    assert.equal(args.headers.Authorization, undefined);
    assert.equal(args.headers.Cookie, undefined);
    return avatar();
  }, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([{ ...repo('team/project'), owner: { login: 'team', avatar_url: 'https://avatars.githubusercontent.com/u/100?v=4&s=512' } }]);
    return searchBody([feedItem('team/project', 17, { user: { login: 'someone-else', avatar_url: 'https://avatars.githubusercontent.com/u/999' },
      repository: { full_name: 'team/project', owner: { login: 'team', avatar_url: 'https://avatars.githubusercontent.com/u/200' } } })]);
  } });
  const view = await renderWithAvatars(f);
  const entry = view.children[0].items[0];
  assert.equal(entry.avatarBase64, image);
  assert.equal(entry.symbol, 'person.crop.circle');
  assert.equal(entry.subtitle, '#17 · team/project');
  assert.equal(entry.children[0].type, 'badge');
  assert.equal(entry.children[0].text, 'Open');
  assert.equal(entry.children[0].tone, 'success');
  assert.equal(f.requests.filter(request => request.responseEncoding === 'base64').length, 1);
  assert.doesNotMatch(JSON.stringify(entry), /someone-else|Bearer|avatars\.githubusercontent\.com/);
});

test('Repository owner metadata from the feed is usable before repository list pagination reaches it', async () => {
  const f = fixture({ saved: connection, ownerAvatarRoute: async url => {
    assert.equal(url.pathname, '/u/55');
    return avatar();
  }, route: async url => basics(url) || searchBody([feedItem('organization/project', 1, {
    repository: { full_name: 'organization/project', owner: { login: 'organization', avatar_url: 'https://avatars.githubusercontent.com/u/55' } },
  })]) });
  assert.equal((await renderWithAvatars(f)).children[0].items[0].avatarBase64, image);
});

test('Missing or unsafe owner URLs use only the validated public owner fallback and never the author', async () => {
  for (const source of [undefined, 'http://avatars.githubusercontent.com/u/1', 'https://evil.test/image',
    'https://avatars.githubusercontent.com.evil.test/u/1', 'https://secret@avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com/u/1#fragment', 'https://avatars.githubusercontent.com\\@evil.test/u/1']) {
    const f = fixture({ saved: connection, ownerAvatarRoute: async url => {
      assert.equal(url.href, 'https://avatars.githubusercontent.com/team?s=64');
      return avatar();
    }, route: async url => basics(url) || searchBody([feedItem('team/project', 1, {
      repository: { full_name: 'team/project', owner: { login: 'team', avatar_url: source } },
      user: { login: 'author', avatar_url: 'https://evil.test/author' },
    })]) });
    assert.equal((await renderWithAvatars(f)).children[0].items[0].avatarBase64, image);
    assert.ok(f.requests.every(request => ['api.github.com', 'avatars.githubusercontent.com'].includes(new URL(request.url).hostname)));
  }
});

test('Repeated owners use one public download across filtering, refresh and Issues PR switches', async () => {
  const f = fixture({ saved: connection, ownerAvatarRoute: async () => avatar(), route: async url => basics(url) || searchBody([
    feedItem('team/first', 1), feedItem('team/second', 2), feedItem('team/third', 3, { pull_request: {} }),
  ]) });
  for (const event of [{}, { action: 'query', value: 'team' }, { action: 'refresh' }, { action: 'kind:pulls' }, { action: 'kind:issues' }]) {
    assert.ok((await renderWithAvatars(f, event)).children[0].items.every(entry => entry.avatarBase64 === image));
  }
  assert.equal(f.requests.filter(request => request.responseEncoding === 'base64').length, 1);
});

test('Malformed oversized and unavailable owner images stay cached until an explicit refresh', async () => {
  for (const result of [{ status: 404 }, avatar('bad base64'), avatar(image, 'text/html'), avatar(Buffer.alloc(8 * 1024 + 1).toString('base64'))]) {
    const f = fixture({ saved: connection, ownerAvatarRoute: async () => result, route: async url => basics(url) || searchBody([feedItem('team/project', 1)]) });
    for (const event of [{}, { action: 'refresh' }]) {
      const view = await renderWithAvatars(f, event);
      assert.equal(view.children[0].items.length, 1);
      assert.equal(view.children[0].items[0].avatarBase64, undefined);
      assert.doesNotMatch(texts(view), /invalid response|could not be reached/);
    }
    assert.equal(f.requests.filter(request => request.responseEncoding === 'base64').length, 2);
  }
});

test('Owner downloads run at most four together and deferred old account images cannot modify a new account', async () => {
  const started = deferred(), release = deferred();
  let active = 0, maximum = 0;
  const f = fixture({ saved: connection, ownerAvatarRoute: async () => {
    active++; maximum = Math.max(maximum, active); started.resolve();
    await release.promise; active--; return avatar();
  }, route: async (url, args) => {
    const newer = args.headers.Authorization === 'Bearer newer_token';
    if (url.pathname === '/user') return body({ login: newer ? 'bob' : 'alice' });
    if (url.pathname === '/user/repos') return body([]);
    return searchBody(newer ? [] : Array.from({ length: 8 }, (_, index) => feedItem(`team-${index}/project`, index + 1)));
  } });
  const old = f.renderReady({});
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 4);
  const current = await f.renderReady({ action: 'connect-token', values: { token: 'newer_token' } });
  assert.equal(current.children[0].children[0].text, 'bob');
  release.resolve();
  assert.equal((await old).children[0].children[0].text, 'alice', 'The initial readable view is returned before the old owner images');
  await new Promise(resolve => setImmediate(resolve));
  const late = await f.renderReady({});
  assert.equal(late.children[0].children[0].text, 'bob');
  assert.equal(late.children[0].items.length, 0);
  assert.ok(nodes(late).every(entry => entry.avatarBase64 === undefined));
});

test('Overlapping panel filters share the four-request avatar limit', async () => {
  const started = deferred(), release = deferred();
  let active = 0, maximum = 0;
  const f = fixture({ saved: connection, ownerAvatarRoute: async () => {
    active++; maximum = Math.max(maximum, active);
    if (active === 4) started.resolve();
    await release.promise; active--; return avatar();
  }, route: async url => basics(url) || searchBody(Array.from({ length: 8 }, (_, index) =>
    feedItem(`team-${index}/project`, index + 1, { title: index < 4 ? 'First owners' : 'Later owners' }))) });
  const initial = f.renderReady({});
  await started.promise;
  const filtered = f.render({ action: 'query', value: 'Later' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 4);
  release.resolve();
  await Promise.all([initial, filtered]);
  assert.equal(maximum, 4);
});

test('Items expose bounded scroll pagination metadata without any Load more items buttons', async () => {
  const f = fixture({ saved: connection, route: async url => basics(url) || searchBody([feedItem('team/project', 1)], 200, next) });
  const initial = await f.renderReady({});
  const sidebar = initial.children[0];
  assert.equal(sidebar.loadMoreAction, 'more-items');
  assert.ok(sidebar.loadMoreToken && Buffer.byteLength(sidebar.loadMoreToken) <= 256);
  assert.ok(!nodes(initial).some(entry => entry.action === 'more-items'));
  const second = await f.render({ action: 'more-items' });
  assert.notEqual(second.children[0].loadMoreToken, sidebar.loadMoreToken);
  assert.equal(new URL(apiRequests(f).at(-1).url).searchParams.get('page'), '2');
});

test('Every reload has a fresh scroll token even when returning to the same type, scope and first page', async () => {
  const f = fixture({ saved: connection, route: async url => basics(url) || searchBody([feedItem('team/project', 1), feedItem('team/project', 2, { pull_request: {} })], 200, next) });
  const first = (await f.renderReady({})).children[0].loadMoreToken;
  await f.renderReady({ action: 'kind:pulls' });
  const returned = (await f.renderReady({ action: 'kind:issues' })).children[0].loadMoreToken;
  const refreshed = (await f.renderReady({ action: 'refresh' })).children[0].loadMoreToken;
  assert.notEqual(first, returned);
  assert.notEqual(returned, refreshed);
  const filtered = await f.render({ action: 'query', value: 'Work' });
  assert.equal(filtered.children[0].loadMoreToken, undefined);
  assert.equal(filtered.children[0].loadMoreAction, undefined);
  assert.match(texts(filtered), /Clear search or filters/);
  const cleared = await f.render({ action: 'clear-filters' });
  assert.equal(cleared.children[0].loadMoreToken, refreshed);
});

test('Concurrent or stale load-more callbacks never duplicate an in-flight or final-page request', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ saved: connection, route: async url => {
    const basic = basics(url); if (basic) return basic;
    if (url.searchParams.get('page') === '1') return searchBody([feedItem('team/project', 1)], 200, next);
    started.resolve(); await release.promise; return searchBody([feedItem('team/project', 2)]);
  } });
  await f.renderReady({});
  const loading = f.render({ action: 'more-items' });
  await started.promise;
  const concurrent = await f.render({ action: 'more-items' });
  assert.equal(concurrent.children[0].loadMoreAction, undefined);
  assert.equal(apiRequests(f).filter(request => new URL(request.url).searchParams.get('page') === '2').length, 1);
  release.resolve();
  const finished = await loading;
  assert.deepEqual(Array.from(finished.children[0].items, entry => entry.id), ['item-team/project/1', 'item-team/project/2']);
  assert.equal(finished.children[0].loadMoreAction, undefined);
  const count = f.requests.length;
  await f.render({ action: 'more-items' });
  assert.equal(f.requests.length, count);
});

test('A failed next-page retry preserves current rows and continues that page instead of starting over', async () => {
  let fails = true;
  const f = fixture({ saved: connection, route: async url => {
    const basic = basics(url); if (basic) return basic;
    if (url.searchParams.get('page') === '1') return searchBody([feedItem('team/project', 1)], 200, next);
    return fails ? body({}, 503) : searchBody([feedItem('team/project', 2)]);
  } });
  await f.renderReady({});
  const failed = await f.render({ action: 'more-items' });
  assert.equal(failed.children[0].items.length, 1);
  assert.equal(failed.children[0].loadMoreAction, undefined);
  assert.ok(nodes(failed).some(entry => entry.action === 'retry-load'));
  const searched = await f.render({ action: 'query', value: 'Work' });
  assert.match(texts(searched), /could not be reached/);
  assert.equal(searched.children[0].loadMoreAction, undefined);
  fails = false;
  const recovered = await f.render({ action: 'retry-load' });
  assert.equal(recovered.children[0].items.length, 2);
  assert.doesNotMatch(texts(recovered), /could not be reached/);
  assert.deepEqual(apiRequests(f).filter(request => new URL(request.url).pathname === '/search/issues').map(request => new URL(request.url).searchParams.get('page')), ['1', '2', '2']);
});

test('Growing lists retain their earliest row and stop at a stable display limit without dropping the prefix', async () => {
  const f = fixture({ saved: connection, ownerAvatarRoute: async () => avatar(Buffer.alloc(7 * 1024).toString('base64')),
    route: async url => basics(url) || searchBody(Array.from({ length: 50 }, (_, index) => {
      const number = (Number(url.searchParams.get('page')) - 1) * 50 + index + 1;
      return feedItem('team/project', number);
    }), 200, next) });
  let view = await f.renderReady({});
  for (let page = 2; page <= 8; page++) view = await f.render({ action: 'more-items' });
  assert.equal(view.children[0].items.length, 400);
  assert.equal(view.children[0].items[0].id, 'item-team/project/1');
  assert.equal(view.children[0].items.at(-1).id, 'item-team/project/400');
  assert.equal(view.children[0].loadMoreAction, undefined);
  assert.match(texts(view), /Narrow the repository or search/);
  assert.ok(nodes(view).length <= 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 400 * 1024);
  assert.equal(f.requests.filter(request => request.responseEncoding === 'base64').length, 1);
});

test('Chinese active sidebar keeps concise open and draft labels and excludes closed and merged PRs', async () => {
  const f = fixture({ saved: connection, locale: 'zh-Hans', route: async url => basics(url) || searchBody([
    feedItem('team/project', 1, { pull_request: {} }), feedItem('team/project', 2, { pull_request: {}, state: 'closed' }),
    feedItem('team/project', 3, { pull_request: { merged_at: '2026-10-14' }, state: 'closed' }), feedItem('team/project', 4, { pull_request: {}, draft: true }),
  ]) });
  await f.renderReady({});
  const view = await f.renderReady({ action: 'kind:pulls' });
  assert.deepEqual(Array.from(view.children[0].items, entry => [entry.children[0].text, entry.children[0].tone]),
    [['打开', 'success'], ['草稿', 'muted']]);
});

test('Full PR details update the corresponding sidebar status while preserving identity and order', async () => {
  const first = feedItem('team/project', 7, { pull_request: {} });
  const second = feedItem('other/project', 7, { pull_request: {} });
  const f = fixture({ saved: connection, route: async url => basics(url) ||
    (url.pathname === '/search/issues' ? searchBody([first, second]) : body({ ...second, id: 9000, draft: true, body: 'Complete draft PR' })) });
  await f.renderReady({});
  const initial = await f.renderReady({ action: 'kind:pulls' });
  assert.deepEqual(Array.from(initial.children[0].items, entry => entry.children[0].text), ['Open', 'Open']);
  const selected = await f.renderReady({ action: 'item:item-other/project/7' });
  assert.deepEqual(Array.from(selected.children[0].items, entry => [entry.id, entry.children[0].text]),
    [['item-team/project/7', 'Open'], ['item-other/project/7', 'Draft']]);
  assert.equal(selected.children[0].value, 'item-other/project/7');
  assert.match(texts(selected.children[1]), /Complete draft PR/);
});

test('Local loaded-item filters cannot trigger further network pages until cleared', async () => {
  const f = fixture({ saved: connection, route: async url => basics(url) || searchBody([feedItem('team/project', 1)], 200, next) });
  await f.renderReady({});
  for (const event of [{ action: 'query', value: 'not loaded' }, { action: 'author', value: 'other' }, { action: 'label', value: 'label' }]) {
    await f.render({ action: 'clear-filters' });
    const filtered = await f.render(event);
    assert.equal(filtered.children[0].loadMoreAction, undefined);
    assert.equal(filtered.children[0].loadMoreToken, undefined);
    const count = f.requests.length;
    await f.render({ action: 'more-items' });
    assert.equal(f.requests.length, count);
  }
  const cleared = await f.render({ action: 'clear-filters' });
  assert.equal(cleared.children[0].loadMoreAction, 'more-items');
});

test('Canonical slash-heavy inline images stay below Swift encoded view limits without losing loaded rows', async () => {
  const f = fixture({ saved: connection, ownerAvatarRoute: async () => avatar(Buffer.alloc(8 * 1024, 255).toString('base64')),
    route: async url => basics(url) || searchBody(Array.from({ length: 50 }, (_, index) => {
      const number = (Number(url.searchParams.get('page')) - 1) * 50 + index + 1;
      return feedItem('team/project', number);
    }), 200, next) });
  let view = await f.renderReady({});
  for (let page = 2; page <= 4; page++) view = await f.render({ action: 'more-items' });
  const withSwiftDefaults = item => ({ ...item, disabled: item.disabled || false, options: item.options || [],
    children: (item.children || []).map(withSwiftDefaults), items: (item.items || []).map(withSwiftDefaults) });
  const serialized = JSON.stringify(withSwiftDefaults(view)).replace(/\//g, '\\/');
  assert.ok(Buffer.byteLength(serialized) <= 512 * 1024);
  assert.equal(view.children[0].items.length, 200);
  assert.equal(view.children[0].items[0].id, 'item-team/project/1');
  assert.equal(view.children[0].items.at(-1).id, 'item-team/project/200');
  assert.ok(nodes(view).length <= 1000);
  assert.ok(view.children[0].items.some(entry => entry.avatarBase64));
  assert.ok(view.children[0].items.some(entry => !entry.avatarBase64));
});
