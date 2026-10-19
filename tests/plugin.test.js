import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, texts, connection } from './fixtures/plugin-fixture.js';
const avatarPNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const avatarJPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=';
const accountHeader = view => view.children[0].children[0];
const apiRequests = f => f.requests.filter(request => new URL(request.url).hostname === 'api.github.com');
const avatarResponse = (bodyBase64 = avatarPNG, status = 200, contentType = 'image/png') => ({
  status, headers: { 'content-type': contentType }, bodyBase64,
});
function itemResponse(url, items, status = 200, headers = {}) {
  if (url.pathname === '/search/issues') {
    const pulls = (url.searchParams.get('q') || '').includes('is:pull-request');
    return searchBody(items.filter(item => Boolean(item.pull_request) === pulls), status, headers);
  }
  const number = /^\/repos\/[^/]+\/[^/]+\/(issues|pulls)\/([1-9][0-9]*)$/.exec(url.pathname)?.[2];
  return body(number ? items.find(item => item.number === Number(number)) || {} : items, status, headers);
}
function repositoryIssue(url, number, title, extra = {}) {
  const repository = /^\/repos\/([^/]+\/[^/]+)\//.exec(url.pathname)?.[1]
    || /(?:^| )repo:([^ ]+)/.exec(url.searchParams.get('q') || '')?.[1] || 'alice/project';
  return issue(number, title, { repository_url: `https://api.github.com/repos/${repository}`,
    html_url: `https://github.com/${repository}/issues/${number}`, ...extra });
}

test('The sign-in screen describes local credential storage in both languages without Keychain or encryption claims', async () => {
  for (const locale of ['en', 'zh-Hans']) {
    const f = fixture({ locale });
    const view = await f.renderReady({});
    const copy = texts(view);
    assert.ok(copy.includes(locale === 'en'
      ? 'Nora stores your account credentials locally on this Mac.'
      : 'Nora 将账号凭据保存在这台 Mac 本地。'));
    assert.doesNotMatch(copy, /Keychain|钥匙串|encrypt|加密/i);
    assert.equal(f.writes.length, 0);
  }
});

test('The first sidebar row is the username menu with the real public avatar and no GitHub title', async () => {
  const f = fixture({ saved: connection, route: async (url, args) => {
    if (url.pathname === '/user') return body({ id: 1, login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4&s=512' });
    if (url.hostname === 'avatars.githubusercontent.com') {
      assert.equal(url.searchParams.get('s'), '64');
      assert.equal(url.searchParams.get('v'), '4');
      assert.equal(args.responseEncoding, 'base64');
      assert.equal(args.maximumResponseBytes, 96 * 1024);
      assert.equal(args.timeoutSeconds, 8);
      assert.deepEqual(Object.keys(args.headers), ['Accept']);
      assert.equal(args.headers.Accept, 'image/png,image/jpeg');
      assert.equal(args.headers.Authorization, undefined);
      assert.equal(args.headers.Cookie, undefined);
      return avatarResponse();
    }
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Issue one')]);
  } });
  const view = await f.renderReady({});
  const account = accountHeader(view);
  assert.equal(account.type, 'menu');
  assert.equal(account.text, 'alice');
  assert.equal(account.tone, 'neutral');
  assert.equal(account.symbol, 'person.crop.circle');
  assert.equal(account.avatarBase64, avatarPNG);
  assert.notEqual(account.appearance, 'icon');
  assert.ok(nodes(account).some(node => node.action === 'disconnect'));
  assert.ok(!nodes(view.children[0]).some(node => node.type === 'toolbar' || node.text === 'GitHub'));
  assert.match(texts(view), /Issue one/);
  assert.doesNotMatch(JSON.stringify(view), /test_token|Bearer|avatar_url|avatars\.githubusercontent\.com/);
  assert.equal(f.requests.filter(request => request.responseEncoding === 'base64').length, 1);
});

test('The account menu starts with repository actions without repeating the username', async () => {
  for (const locale of ['en', 'zh-Hans']) {
    const f = fixture({ saved: connection, locale });
    const account = accountHeader(await f.renderReady({}));
    assert.equal(account.text, 'alice');
    assert.equal(nodes(account).filter(node => node.text === 'alice').length, 1);
    assert.equal(account.children[0].type, 'button');
    assert.equal(account.children[0].text, locale === 'en' ? 'Open another repository…' : '打开其他仓库…');
    assert.deepEqual(Array.from(account.children, node => node.action || node.type),
      ['show-other-repo', 'manage', 'refresh-repos', 'divider', 'disconnect']);
    assert.ok(account.children.filter(node => node.type === 'button').every(node => !node.disabled));
    assert.equal(f.stored(), connection);
    assert.equal(f.writes.length, 0);
  }
});

test('Missing or untrusted avatar URLs keep the account placeholder without requesting another website', async () => {
  for (const avatarURL of [undefined, '', 'http://avatars.githubusercontent.com/u/1',
    'https://github.com/u/1', 'https://avatars.githubusercontent.com.evil.test/u/1',
    'https://name:secret@avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com:444/u/1',
    'https://avatars.githubusercontent.com/u/1#fragment', 'https://avatars.githubusercontent.com\\@evil.test/u/1']) {
    const f = fixture({ saved: connection, route: async url => {
      if (url.pathname === '/user') return body({ login: 'alice', avatar_url: avatarURL });
      if (url.pathname === '/user/repos') return body([repo()]);
      return itemResponse(url, [issue(1, 'Issue one')]);
    } });
    const view = await f.renderReady({});
    assert.equal(accountHeader(view).text, 'alice');
    assert.equal(accountHeader(view).symbol, 'person.crop.circle');
    assert.equal(accountHeader(view).avatarBase64, undefined);
    assert.match(texts(view), /Issue one/);
    assert.equal(f.requests.filter(request => request.responseEncoding === 'base64' && request.maximumResponseBytes === 96 * 1024).length, 0);
    assert.ok(f.requests.every(request => ['api.github.com', 'avatars.githubusercontent.com'].includes(new URL(request.url).hostname)));
  }
});

test('Unavailable malformed oversized and non-image avatars never fail the connected account', async () => {
  const responses = [
    () => { throw new Error('Private transport error'); },
    () => avatarResponse(avatarPNG, 404),
    () => avatarResponse(avatarPNG, 200, 'text/html'),
    () => avatarResponse('not base64'),
    () => avatarResponse('AB=='),
    () => avatarResponse(Buffer.alloc(96 * 1024 + 1).toString('base64')),
    () => avatarResponse(''),
  ];
  for (const response of responses) {
    const f = fixture({ saved: connection, route: async url => {
      if (url.pathname === '/user') return body({ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
      if (url.hostname === 'avatars.githubusercontent.com') return response();
      if (url.pathname === '/user/repos') return body([repo()]);
      return itemResponse(url, [issue(1, 'Issue one')]);
    } });
    const view = await f.renderReady({});
    assert.equal(accountHeader(view).text, 'alice');
    assert.equal(accountHeader(view).avatarBase64, undefined);
    assert.match(texts(view), /Issue one/);
    assert.doesNotMatch(texts(view), /Private transport|invalid response|could not be reached/);
    await f.render({ action: 'refresh-repos' });
    assert.equal(f.requests.filter(request => request.responseEncoding === 'base64').length, 1);
  }
});

test('The public avatar is cached across filtering repository refreshes and Issues PR switches', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com:443/u/1?%73=900&s=32&v=4' });
    if (url.hostname === 'avatars.githubusercontent.com') {
      assert.deepEqual(url.searchParams.getAll('s'), ['64']);
      return avatarResponse(avatarJPEG, 200, 'image/jpeg; charset=binary');
    }
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Issue one')]);
  } });
  for (const event of [{}, { action: 'query', values: { query: 'Issue' } },
    { action: 'refresh-repos' }, { action: 'kind:pulls' }, { action: 'refresh' }]) {
    assert.equal(accountHeader(await f.renderReady(event)).avatarBase64, avatarJPEG);
  }
  assert.equal(f.requests.filter(request => request.responseEncoding === 'base64').length, 1);
});

test('A token connection also loads the public avatar while repository loading runs in parallel', async () => {
  const started = deferred(), release = deferred();
  let repositoriesLoaded = false;
  const f = fixture({ route: async (url, args) => {
    if (url.pathname === '/user') return body({ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
    if (url.hostname === 'avatars.githubusercontent.com') {
      assert.equal(args.headers.Authorization, undefined);
      started.resolve();
      await release.promise;
      return avatarResponse();
    }
    if (url.pathname === '/user/repos') { repositoriesLoaded = true; return body([repo()]); }
    return itemResponse(url, [issue(1, 'Issue one')]);
  } });
  const connecting = f.renderReady({ action: 'connect-token', values: { token: 'test_token' } });
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(repositoriesLoaded, true);
  const initial = await connecting;
  assert.equal(accountHeader(initial).avatarBase64, undefined);
  assert.match(texts(initial), /Issue one/);
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const view = await f.renderReady({});
  assert.equal(accountHeader(view).avatarBase64, avatarPNG);
  assert.match(texts(view), /Issue one/);
  assert.equal(JSON.parse(f.stored()).token, 'test_token');
});

test('A completed browser device login loads its own public avatar without passing its token', async () => {
  let now = 0;
  const f = fixture({ now: () => now, route: async (url, args) => {
    if (url.pathname === '/login/device/code') return body(device());
    if (url.pathname === '/login/oauth/access_token') return body({ access_token: 'device_token', token_type: 'bearer' });
    if (url.pathname === '/user') return body({ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
    if (url.hostname === 'avatars.githubusercontent.com') {
      assert.equal(args.headers.Authorization, undefined);
      return avatarResponse();
    }
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Issue one')]);
  } });
  await f.render({ action: 'begin-login' });
  now = 6000;
  const view = await f.renderReady({ action: 'finish-login' });
  assert.equal(accountHeader(view).text, 'alice');
  assert.equal(accountHeader(view).avatarBase64, avatarPNG);
  assert.equal(JSON.parse(f.stored()).token, 'device_token');
});

test('An old avatar response cannot replace the newer accounts avatar or username', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ route: async (url, args) => {
    if (url.pathname === '/user') {
      const older = args.headers.Authorization === 'Bearer older_token';
      return body({ id: older ? 1 : 2, login: older ? 'alice' : 'bob', avatar_url: `https://avatars.githubusercontent.com/u/${older ? 1 : 2}` });
    }
    if (url.hostname === 'avatars.githubusercontent.com') {
      assert.equal(args.headers.Authorization, undefined);
      if (url.pathname === '/u/1') { started.resolve(); await release.promise; return avatarResponse(); }
      return avatarResponse(avatarJPEG, 200, 'image/jpeg');
    }
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Issue one')]);
  } });
  const older = f.renderReady({ action: 'connect-token', values: { token: 'older_token' } });
  await started.promise;
  const previous = await older;
  assert.equal(accountHeader(previous).text, 'alice', 'The old readable snapshot must not wait for its optional avatar');
  assert.equal(accountHeader(previous).avatarBase64, undefined);
  const current = await f.renderReady({ action: 'connect-token', values: { token: 'newer_token' } });
  assert.equal(accountHeader(current).text, 'bob');
  assert.equal(accountHeader(current).avatarBase64, avatarJPEG);
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const late = await f.renderReady({});
  assert.equal(accountHeader(late).text, 'bob');
  assert.equal(accountHeader(late).avatarBase64, avatarJPEG);
  assert.equal(JSON.parse(f.stored()).token, 'newer_token');
  assert.equal(f.requests.filter(request => request.responseEncoding === 'base64' && request.maximumResponseBytes === 96 * 1024).length, 2);
});

test('Disconnect clears the avatar and a new connection fetches its own copy', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
    if (url.hostname === 'avatars.githubusercontent.com') return avatarResponse();
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Issue one')]);
  } });
  assert.equal(accountHeader(await f.renderReady({})).avatarBase64, avatarPNG);
  const disconnected = await f.render({ action: 'disconnect' });
  assert.equal(disconnected.type, 'emptyState');
  assert.ok(nodes(disconnected).every(node => node.avatarBase64 === undefined));
  assert.equal(f.stored(), null);
  assert.equal(accountHeader(await f.renderReady({ action: 'connect-token', values: { token: 'new_token' } })).avatarBase64, avatarPNG);
  assert.equal(f.requests.filter(request => request.responseEncoding === 'base64').length, 2);
});
test('Script manifest has no native extension or signing identity', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../nora-plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.runtime, 'script');
  assert.equal(manifest.entryPoint, 'plugin.js');
  assert.equal(manifest.extensionBundleIdentifier, undefined);
  assert.equal(manifest.teamIdentifier, undefined);
  assert.ok(manifest.permissions.includes('chat'));
});
test('Disconnected native view describes the user account and never exposes App setup', async () => {
  const f = fixture();
  const view = await f.renderReady({});
  assert.match(texts(view), /your own account/);
  assert.equal(view.type, 'emptyState');
  assert.ok(nodes(view).some(node => node.action === 'begin-login' && node.appearance === 'primary'));
  assert.ok(!nodes(view).some(node => node.type === 'secureField'));
  assert.ok(nodes(await f.render({ action: 'toggle-token' })).some(node => node.type === 'secureField'));
  assert.ok(!nodes(await f.render({ action: 'toggle-token' })).some(node => node.type === 'secureField'));
  assert.doesNotMatch(texts(view), /Client ID|nora-release\/nora/);
  assert.equal(f.requests.length, 0);
  await f.render({ action: 'manage' });
  assert.deepEqual(f.links, ['https://github.com/apps/nora-github-plugin/installations/new']);
});
test('Chinese view uses the same public SDK with native controls', async () => {
  const view = await fixture({ locale: 'zh-Hans' }).renderReady({});
  assert.match(texts(view), /连接你自己的账号/);
  assert.match(texts(view), /管理仓库访问权限/);
  assert.ok(nodes(view).every(node => !['html', 'webview'].includes(node.type)));
});
test('Repos and Issues are read under the connected user credentials', async () => {
  const f = fixture({ saved: JSON.stringify(connection) });
  const view = await f.renderReady({});
  assert.match(texts(view), /alice/);
  assert.match(texts(view), /Issue one/);
  assert.ok(apiRequests(f).every(request => request.headers.Authorization === 'Bearer test_token'));
  const repository = nodes(view.children[0]).find(node => node.id === 'repository');
  assert.equal(repository.value, '');
  assert.ok(repository.options.some(option => option.value === 'alice/project'));
  assert.ok(f.requests.some(request => new URL(request.url).pathname === '/search/issues'));
  assert.ok(!f.requests.some(request => new URL(request.url).pathname === '/repos/alice/project/issues'));
});

test('Issues exclude PRs and the active PR view keeps drafts while excluding merged work', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Real issue'),
      issue(3, 'Work in progress', { pull_request: {}, draft: true }),
      issue(4, 'Finished', { pull_request: {}, state: 'closed', merged_at: '2026-10-01T00:00:00Z' })]);
  } });
  assert.doesNotMatch(texts(await f.renderReady({})), /Work in progress|Finished/);
  const view = await f.renderReady({ action: 'kind', values: { kind: 'pulls' } });
  assert.match(texts(view.children[0]), /Work in progress/);
  assert.doesNotMatch(texts(view.children[0]), /Finished/);
  assert.doesNotMatch(texts(view.children[0]), /Real issue/);
  const draft = await f.renderReady({ action: 'item:item-alice/project/3' });
  assert.match(texts(draft.children[1]), /Draft/);
  const requests = f.requests.length;
  const unchanged = await f.renderReady({ action: 'item:item-alice/project/4' });
  assert.equal(f.requests.length, requests, 'A removed merged row cannot be reopened by an old sidebar action');
  assert.ok(!unchanged.value);
  assert.ok(!nodes(unchanged).some(node => node.id === 'item-details'));
});

test('Invalid PAT never overwrites saved credentials', async () => {
  const f = fixture({ saved: connection, route: async (url, args) => {
    if (args.headers.Authorization === 'Bearer invalid_token') return body({}, 401);
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return url.pathname === '/search/issues' ? searchBody([]) : body([]);
  } });
  const view = await f.render({ action: 'connect-token', values: { token: 'invalid_token' } });
  assert.match(texts(view), /expired/);
  assert.equal(f.stored(), connection);
  assert.equal(f.writes.length, 0);
});
test('Local filters avoid requests and opening an issue retrieves its full description', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Alpha'), issue(2, 'Beta')]);
  } });
  await f.renderReady({});
  const before = f.requests.length;
  const view = await f.render({ action: 'query', values: { query: 'Beta' } });
  assert.doesNotMatch(texts(view), /Alpha/);
  assert.match(texts(view), /Beta/);
  assert.equal(f.requests.length, before);
  const detail = await f.renderReady({ action: 'item:item-alice/project/2' });
  assert.match(texts(detail.children[1]), /Description/);
  assert.equal(f.requests.length, before + 1);
  assert.equal(new URL(f.requests.at(-1).url).pathname, '/repos/alice/project/issues/2');
  await f.render({ action: 'open-item' });
  assert.deepEqual(f.links, ['https://github.com/alice/project/issues/2']);
});

test('Page loading deduplicates and commands validate untrusted repository inputs', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return url.searchParams.get('page') === '2' ? itemResponse(url, [issue(1, 'Alpha'), issue(2, 'Beta')]) : itemResponse(url, [issue(1, 'Alpha')], 200, { link: '<https://api.github.com/search/issues?page=2>; rel="next"' });
  } });
  await f.renderReady({});
  const view = await f.render({ action: 'more-items' });
  assert.equal(nodes(view).filter(node => node.id === 'item-alice/project/1').length, 1);
  assert.match(texts(view), /Beta/);
  const count = f.requests.length;
  await assert.rejects(f.command('listIssues', { repository: '../secrets' }), /owner\/name/);
  await assert.rejects(f.command('listIssues', { repository: 'alice/project', page: 0 }), /Invalid page/);
  await assert.rejects(f.command('listPullRequests', { repository: 'alice/project', state: 'unknown' }), /Invalid state/);
  assert.equal(f.requests.length, count);
});
test('Device flow generates a code without credentials and cancellation stays disconnected', async () => {
  const f = fixture({ route: async () => body({ device_code: 'device_123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }) });
  const view = await f.render({ action: 'begin-login' });
  assert.match(texts(view), /ABCD-1234/);
  assert.equal(f.writes.length, 0);
  await f.render({ action: 'open-login' });
  assert.deepEqual(f.links, ['https://github.com/login/device']);
  assert.doesNotMatch(texts(await f.render({ action: 'cancel-login' })), /ABCD-1234/);
});
test('Invalid device responses never expose a link or save credentials', async () => {
  const f = fixture({ route: async () => body({ device_code: 'device_123', user_code: 'ABCD-1234', verification_uri: 'https://malicious.test/', expires_in: 900, interval: 5 }) });
  const view = await f.render({ action: 'begin-login' });
  assert.match(texts(view), /invalid response/);
  assert.doesNotMatch(texts(view), /ABCD-1234|malicious/);
  assert.equal(f.writes.length, 0);
});
test('Concurrent commands coalesce refresh and preserve rotated credentials', async () => {
  let refreshes = 0;
  const f = fixture({ saved: { token: 'old_token', expiresAt: 1, refreshToken: 'refresh_test' }, route: async (url, args) => {
    if (url.hostname === 'github.com') { ++refreshes; await new Promise(resolve => setImmediate(resolve)); return body({ access_token: 'new_token', token_type: 'bearer', expires_in: 28800, refresh_token: 'new_refresh', refresh_token_expires_in: 86400 }); }
    assert.equal(args.headers.Authorization, 'Bearer new_token');
    return body([]);
  } });
  await Promise.all([f.command('listRepositories'), f.command('listRepositories')]);
  assert.equal(refreshes, 1);
  assert.equal(JSON.parse(f.stored()).refreshToken, 'new_refresh');
});
test('Disconnect during an old repository response never restores that account', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') { started(); await wait; return body([repo()]); }
    return url.pathname === '/search/issues' ? searchBody([]) : body([]);
  } });
  const restore = await f.render({});
  assert.equal(restore.id, 'github-restoring');
  await pending;
  await f.render({ action: 'disconnect' });
  release();
  await new Promise(resolve => setImmediate(resolve));
  const view = await f.renderReady({});
  assert.doesNotMatch(texts(view), /alice/);
  assert.equal(f.stored(), null);
  assert.ok(nodes(view).some(node => node.action === 'begin-login'));
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const device = () => ({ device_code: 'device_123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
test('Cancelling a device request before its response cannot resurrect the code', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ route: async () => { started.resolve(); await release.promise; return body(device()); } });
  const login = f.render({ action: 'begin-login' });
  await started.promise;
  await f.render({ action: 'cancel-login' });
  release.resolve();
  assert.doesNotMatch(texts(await login), /ABCD-1234/);
  assert.equal(f.stored(), null);
  assert.equal(f.writes.length, 0);
});

test('A newer account connection wins over an older delayed user response', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ route: async (url, args) => {
    const older = args.headers.Authorization === 'Bearer older_token';
    if (url.pathname === '/user') {
      if (older) { started.resolve(); await release.promise; }
      return body({ login: older ? 'alice' : 'bob' });
    }
    if (url.pathname === '/user/repos') return body([repo('bob/project')]);
    return url.pathname === '/search/issues' ? searchBody([]) : body([]);
  } });
  const older = f.render({ action: 'connect-token', values: { token: 'older_token' } });
  await started.promise;
  const current = await f.renderReady({ action: 'connect-token', values: { token: 'newer_token' } });
  release.resolve();
  const stale = await older;
  assert.match(texts(current), /bob/);
  assert.match(texts(stale), /bob/);
  assert.doesNotMatch(texts(stale), /alice|connection changed/);
  assert.equal(JSON.parse(f.stored()).token, 'newer_token');
  assert.equal(f.writes.length, 1);
});

test('Disconnect waits behind an in-flight credential write and deletes its result', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ beforeSave: async () => { started.resolve(); await release.promise; } });
  const connecting = f.render({ action: 'connect-token', values: { token: 'test_token' } });
  await started.promise;
  const disconnecting = f.render({ action: 'disconnect' });
  release.resolve();
  const views = await Promise.all([connecting, disconnecting]);
  assert.equal(f.stored(), null);
  assert.ok(views.every(view => !texts(view).includes('alice')));
  assert.equal(f.requests.filter(request => new URL(request.url).pathname === '/user/repos').length, 0);
});

test('A newer account replaces credentials even when an older save is already pending', async () => {
  const started = deferred(), release = deferred(), newerStarted = deferred();
  const f = fixture({ beforeSave: async value => {
    if (JSON.parse(value).token === 'older_token') { started.resolve(); await release.promise; }
  }, route: async (url, args) => {
    const newer = args.headers.Authorization === 'Bearer newer_token';
    if (url.pathname === '/user') { if (newer) newerStarted.resolve(); return body({ login: newer ? 'bob' : 'alice' }); }
    if (url.pathname === '/user/repos') return body([repo('bob/project')]);
    return url.pathname === '/search/issues' ? searchBody([]) : body([]);
  } });
  const older = f.render({ action: 'connect-token', values: { token: 'older_token' } });
  await started.promise;
  const newer = f.renderReady({ action: 'connect-token', values: { token: 'newer_token' } });
  await newerStarted.promise;
  release.resolve();
  const [, view] = await Promise.all([older, newer]);
  assert.equal(JSON.parse(f.stored()).token, 'newer_token');
  assert.match(texts(view), /bob/);
  assert.doesNotMatch(texts(view), /alice/);
});

test('Disconnect during a pending refresh save cannot restore credentials or request old data', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ saved: { token: 'old_token', expiresAt: 1, refreshToken: 'old_refresh' },
    beforeSave: async () => { started.resolve(); await release.promise; },
    route: async url => {
      if (url.hostname === 'github.com') return body({ access_token: 'rotated_token', token_type: 'bearer', expires_in: 28800, refresh_token: 'rotated_refresh', refresh_token_expires_in: 86400 });
      throw new Error('The disconnected request must not reach repository data');
    },
  });
  const command = f.command('listRepositories');
  await started.promise;
  const disconnected = f.render({ action: 'disconnect' });
  release.resolve();
  await assert.rejects(command, /connection changed/);
  assert.doesNotMatch(texts(await disconnected), /alice/);
  assert.equal(f.stored(), null);
  assert.equal(f.requests.filter(request => new URL(request.url).hostname === 'api.github.com').length, 0);
});

test('A repository switch clears old details immediately and ignores a late older repository', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo('alice/first'), repo('alice/second', 2)]);
    if ((url.searchParams.get('q') || '').includes('repo:alice/second')) { started.resolve(); await release.promise; return itemResponse(url, [repositoryIssue(url, 2, 'Stale second result')]); }
    return itemResponse(url, [repositoryIssue(url, 1, 'First result', { body: 'Old selected details' })]);
  } });
  await f.renderReady({});
  await f.renderReady({ action: 'item:item-alice/project/1' });
  const older = f.render({ action: 'repository', values: { repository: 'alice/second' } });
  await started.promise;
  assert.doesNotMatch(texts(await f.render({ action: 'query', values: { query: '' } })), /First result|Old selected details/);
  await f.render({ action: 'repository', values: { repository: 'alice/first' } });
  release.resolve();
  assert.doesNotMatch(texts(await older), /Stale second result|Old selected details/);
});

test('Manual Finish sign-in observes the interval and persists credentials only after approval', async () => {
  let time = 1_000_000, polls = 0;
  const f = fixture({ now: () => time, route: async url => {
    if (url.pathname === '/login/device/code') return body(device());
    if (url.pathname === '/login/oauth/access_token') {
      return ++polls === 1 ? body({ error: 'authorization_pending' }) : body({ access_token: 'authorized_token', token_type: 'bearer', expires_in: 28800, refresh_token: 'refresh_token', refresh_token_expires_in: 86400 });
    }
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return url.pathname === '/search/issues' ? searchBody([]) : body([]);
  } });
  await f.render({ action: 'begin-login' });
  assert.match(texts(await f.render({ action: 'finish-login' })), /few seconds/);
  assert.equal(polls, 0);
  time += 5000;
  assert.match(texts(await f.render({ action: 'finish-login' })), /Waiting for your confirmation/);
  assert.equal(f.writes.length, 0);
  time += 5000;
  const connected = await f.renderReady({ action: 'finish-login' });
  assert.match(texts(connected), /alice/);
  assert.doesNotMatch(texts(connected), /ABCD-1234/);
  assert.equal(JSON.parse(f.stored()).token, 'authorized_token');
  assert.equal(polls, 2);
});

test('Cancel during the final OAuth response cannot validate or save the cancelled account', async () => {
  let time = 1_000_000;
  const started = deferred(), release = deferred();
  const f = fixture({ now: () => time, route: async url => {
    if (url.pathname === '/login/device/code') return body(device());
    if (url.pathname === '/login/oauth/access_token') {
      started.resolve(); await release.promise;
      return body({ access_token: 'cancelled_token', token_type: 'bearer' });
    }
    throw new Error('Cancelled login must not read private account data');
  } });
  await f.render({ action: 'begin-login' });
  time += 5000;
  const finishing = f.render({ action: 'finish-login' });
  await started.promise;
  await f.render({ action: 'cancel-login' });
  release.resolve();
  assert.doesNotMatch(texts(await finishing), /ABCD-1234/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.requests.filter(request => new URL(request.url).hostname === 'api.github.com').length, 0);
});

test('Starting another login cannot skip a disconnect already queued behind an old save', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ beforeSave: async () => { started.resolve(); await release.promise; }, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/login/device/code') return body(device());
    return url.pathname === '/search/issues' ? searchBody([]) : body([]);
  } });
  const oldConnection = f.render({ action: 'connect-token', values: { token: 'test_token' } });
  await started.promise;
  const disconnecting = f.render({ action: 'disconnect' });
  await f.render({ action: 'begin-login' });
  release.resolve();
  await Promise.all([oldConnection, disconnecting]);
  assert.equal(f.stored(), null);
});

test('Oversized Unicode Issue descriptions remain fully readable inside Nora within native view limits', async () => {
  const description = '你好🧑🏽‍💻'.repeat(20_000);
  const f = fixture({ saved: connection, locale: 'zh-Hans', route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Large description', { body: description })]);
  } });
  await f.renderReady({});
  let detail = await f.renderReady({ action: 'item:item-alice/project/1' });
  const pieces = [];
  for (let page = 0; page < 100; page++) {
    const card = nodes(detail).find(node => node.id === 'issue-description');
    const descriptionNode = nodes(card).find(node => node.type === 'markdown');
    assert.ok(descriptionNode);
    assert.ok(!/[\ud800-\udbff]$/.test(descriptionNode.text));
    assert.ok(nodes(detail).every(node => !node.text || Buffer.byteLength(node.text, 'utf8') <= 64 * 1024));
    assert.ok(Buffer.byteLength(JSON.stringify(detail), 'utf8') <= 512 * 1024);
    pieces.push(descriptionNode.text);
    const next = nodes(card).find(node => node.action?.startsWith('pr-body:') && node.action.endsWith(':next') && !node.disabled);
    if (!next) break;
    detail = await f.render({ action: next.action });
  }
  assert.equal(pieces.join(''), description);
  assert.deepEqual(f.links, []);
  assert.ok(nodes(detail).some(node => node.action === 'open-item'));
  await f.render({ action: 'open-item' });
  assert.deepEqual(f.links, ['https://github.com/alice/project/issues/1']);
});

test('A native workspace lists issues in its sidebar and opens full details directly in its main area', async () => {
  const f = fixture({ saved: connection, supportsNavigationItemIcon: true, now: () => Date.parse('2026-10-12T00:00:00Z'), route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Fix the editor', { updated_at: '2026-10-10T10:00:00Z', labels: [{ name: 'bug' }], body: '## Details\nA real description.' })]);
  } });
  const initial = await f.renderReady({});
  assert.equal(initial.type, 'workspace');
  assert.equal(initial.children.length, 2);
  const sidebar = initial.children[0];
  assert.equal(sidebar.type, 'sidebar');
  assert.equal(sidebar.id, 'item-navigation');
  assert.equal(sidebar.value, '');
  const viewNavigation = nodes(sidebar).find(node => node.id === 'view-navigation');
  assert.equal(viewNavigation.value, 'view-issues');
  assert.deepEqual(Array.from(viewNavigation.items, item => item.action), ['kind:issues', 'kind:pulls']);
  assert.match(viewNavigation.items[0].iconSVG, /M8\.5 7\.5/);
  assert.match(viewNavigation.items[1].iconSVG, /M6 8v8m12 0v-4/);
  const item = sidebar.items[0];
  assert.equal(item.type, 'navigationItem');
  assert.equal(item.id, 'item-alice/project/1');
  assert.equal(item.action, 'item:item-alice/project/1');
  assert.equal(item.text, 'Fix the editor');
  assert.match(item.subtitle, /#1.*alice\/project/);
  assert.equal(item.symbol, 'person.crop.circle');
  assert.equal(item.tone, 'neutral');
  assert.equal(item.children[0].type, 'badge');
  assert.equal(item.children[0].tone, 'success');
  assert.ok(!nodes(initial).some(node => node.type === 'collection' || node.type === 'markdown'));
  const count = f.requests.length;
  const selected = await f.renderReady({ action: item.action });
  assert.equal(selected.children.length, 2);
  assert.equal(selected.children[1].id, 'item-details');
  assert.ok(nodes(selected.children[1]).some(node => node.type === 'markdown' && node.text.includes('A real description.')));
  assert.ok(!nodes(selected.children[0]).some(node => node.type === 'markdown'));
  assert.equal(selected.children[0].value, item.id);
  assert.equal(f.requests.length, count + 1);
  const closed = await f.render({ action: 'close-detail', values: { 'github-workspace': '' } });
  assert.equal(closed.children.length, 2);
  assert.ok(!nodes(closed.children[1]).some(node => node.type === 'markdown'));
  assert.equal(closed.children[0].value, '');
  assert.equal(closed.value, '');
  const reopened = await f.renderReady({ action: item.action });
  assert.equal(reopened.children[1].id, 'item-details');
  assert.equal(f.requests.length, count + 2);
});

test('Account and repository utilities stay in menus and manual repository entry is an explicit operation', async () => {
  const f = fixture({ saved: connection });
  const view = await f.renderReady({});
  assert.ok(!nodes(view).some(node => node.id === 'manual-repo' || node.type === 'secureField'));
  const repositoryMenu = nodes(view).find(node => node.type === 'menu' && node.children.some(child => child.action === 'show-other-repo'));
  assert.ok(repositoryMenu.children.some(child => child.action === 'show-other-repo'));
  assert.ok(nodes(view).some(node => node.type === 'menu' && node.children.some(child => child.action === 'disconnect')));
  const count = f.requests.length;
  assert.ok(nodes(await f.render({ action: 'show-other-repo' })).some(node => node.id === 'manual-repo'));
  assert.ok(!nodes(await f.render({ action: 'cancel-other-repo' })).some(node => node.id === 'manual-repo'));
  assert.equal(f.requests.length, count);
  await f.render({ action: 'show-other-repo' });
  const invalid = await f.render({ action: 'open-repo', values: { 'manual-repo': '../private' } });
  assert.match(texts(invalid), /owner\/name/);
  assert.equal(f.requests.length, count);
  const opened = await f.render({ action: 'open-repo', values: { 'manual-repo': 'bob/other' } });
  assert.match(texts(opened), /bob\/other/);
  assert.ok(!nodes(opened).some(node => node.id === 'manual-repo'));
  assert.equal(new URL(apiRequests(f).at(-1).url).pathname, '/search/issues');
  assert.ok(new URL(apiRequests(f).at(-1).url).searchParams.get('q').includes('repo:bob/other'));
});

test('Search repository and local filters stay with the issue list while account actions remain in its menu', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Editor fix'), issue(2, 'Settings fix', { user: { login: 'bob' } }),
      issue(3, 'Review native changes', { pull_request: {} })]);
  } });
  const initial = await f.renderReady({});
  const [sidebar, main] = initial.children;
  assert.ok(nodes(sidebar).some(node => node.id === 'query' && node.placeholder === 'Search loaded items'));
  assert.ok(nodes(sidebar).some(node => node.id === 'repository' && node.value === ''));
  assert.ok(!nodes(sidebar).some(node => node.id === 'status' || node.action === 'status' || node.action === 'all-states'));
  assert.ok(nodes(sidebar).some(node => node.type === 'menu' && node.text === 'Filters'));
  assert.ok(nodes(main).some(node => node.action === 'refresh'));
  assert.ok(!nodes(main).some(node => node.action === 'disconnect' || node.action === 'show-other-repo' || node.id === 'query'));
  const account = sidebar.children[0];
  assert.equal(account.type, 'menu');
  assert.equal(account.text, 'alice');
  assert.notEqual(account.appearance, 'icon');
  for (const action of ['show-other-repo', 'manage', 'refresh-repos', 'disconnect']) {
    assert.ok(nodes(account).some(node => node.action === action), action);
  }
  const requestCount = f.requests.length;
  const filtered = await f.render({ action: 'author', values: { author: 'bob' } });
  assert.deepEqual(Array.from(filtered.children[0].items, item => item.text), ['Settings fix']);
  assert.match(texts(filtered.children[0]), /Filters · 1/);
  assert.equal(f.requests.length, requestCount);
  const switched = await f.renderReady({ action: 'kind:pulls' });
  assert.equal(nodes(switched.children[0]).find(node => node.id === 'view-navigation').value, 'view-pulls');
  assert.equal(new URL(f.requests.at(-1).url).pathname, '/search/issues');
  assert.match(texts(switched.children[0]), /Review native changes/);
  assert.equal(f.stored(), connection);
  assert.equal(f.writes.length, 0);
});

test('A selected PR has one detail header and a complete Markdown description before an explicit Nora handoff', async () => {
  const f = fixture({ saved: connection, now: () => Date.parse('2026-10-12T00:00:00Z'), route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(42, 'Keep the editor selection when switching pages', {
      pull_request: {}, ...(url.pathname === '/search/issues' ? {} : { state: 'closed', merged_at: '2026-10-10T10:00:00Z' }), updated_at: '2026-10-10T10:00:00Z',
      user: { login: 'bob' }, labels: [{ name: 'native' }, { name: 'reviewed' }],
      html_url: 'https://github.com/alice/project/pull/42', body: '## Changes\nPreserve the selection.\n\n- Keep keyboard focus.'
    })]);
  } });
  await f.renderReady({});
  await f.renderReady({ action: 'kind:pulls' });
  const requestCount = f.requests.length;
  const selected = await f.renderReady({ action: 'item:item-alice/project/42' });
  const detail = selected.children[1];
  assert.equal(detail.id, 'item-details');
  assert.equal(detail.children[0].type, 'toolbar');
  assert.equal(nodes(detail).filter(node => node.type === 'toolbar').length, 1);
  assert.ok(!nodes(detail.children[0]).some(node => node.type === 'text'), 'The window actions must not repeat repository metadata');
  assert.ok(!nodes(detail.children[0]).some(node => node.type === 'badge'));
  assert.equal(nodes(detail.children[1]).filter(node => node.type === 'badge' && node.text === 'Merged').length, 1);
  assert.equal(nodes(detail).find(node => node.id === 'pr-readiness').children[1].children.at(-1).text, 'Merged');
  const title = nodes(detail).find(node => node.textStyle === 'title');
  assert.equal(title.text, 'Keep the editor selection when switching pages');
  assert.ok(!nodes(detail.children[0]).includes(title));
  const description = nodes(detail).find(node => node.id === 'pr-description');
  assert.equal(description.type, 'timelineItem');
  assert.equal(description.value, 'comment');
  assert.match(texts(description), /bob\nopened Oct 10\nnative · reviewed/);
  assert.ok(!nodes(detail.children[1]).some(node => node.text === 'bob'), 'The fixed heading must not repeat the description author');
  assert.equal(nodes(detail).find(node => node.type === 'markdown').text, '## Changes\nPreserve the selection.\n\n- Keep keyboard focus.');
  assert.ok(nodes(detail).some(node => node.action === 'handoff-item' && node.appearance === 'primary'));
  assert.equal(f.drafts.length, 0);
  const loadedRequestCount = f.requests.length;
  await f.render({ action: 'handoff-item' });
  assert.equal(f.drafts.length, 1);
  assert.match(f.drafts[0].context, /Repository: alice\/project\nType: PR\nNumber: #42/);
  assert.match(f.drafts[0].context, /State: Merged\nAuthor: bob/);
  assert.ok(f.drafts[0].context.includes('## Changes\nPreserve the selection.\n\n- Keep keyboard focus.'));
  assert.equal(f.drafts[0].sourceURL, 'https://github.com/alice/project/pull/42');
  assert.doesNotMatch(JSON.stringify(f.drafts[0]), /test_token|Authorization|actionCapability/);
  assert.equal(f.requests.length, loadedRequestCount);
  assert.equal(f.requests.slice(requestCount).filter(request => new URL(request.url).pathname === '/repos/alice/project/pulls/42').length, 1);
  assert.ok(f.requests.slice(requestCount).every(request => request.method === 'GET'));
  assert.equal(f.stored(), connection);
  assert.equal(f.writes.length, 0);
});

test('Sidebar rows stay compact while the full detail keeps every review label', async () => {
  const labels = Array.from({ length: 12 }, (_, index) => ({ name: `label-${index + 1}` }));
  const f = fixture({ saved: connection, now: () => Date.parse('2026-10-12T00:00:00Z'), route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(7, 'Keep all review labels', { user: { login: 'a-long-repository-author' },
      updated_at: '2026-10-10T10:00:00Z', labels })]);
  } });
  const initial = await f.renderReady({});
  const item = initial.children[0].items[0];
  assert.equal(item.type, 'navigationItem');
  assert.equal(item.text, 'Keep all review labels');
  assert.match(item.subtitle, /#7.*alice\/project/);
  assert.ok(!nodes(initial.children[1]).some(node => node.type === 'markdown'));
  const requestCount = apiRequests(f).length;
  const detail = (await f.renderReady({ action: item.action })).children[1];
  const detailLabels = nodes(detail).find(node => node.text === labels.map(label => label.name).join(' · '));
  assert.ok(detailLabels);
  assert.equal(detailLabels.textStyle, 'caption');
  assert.match(texts(detail), /a-long-repository-author\nopened Oct 10/);
  assert.equal(apiRequests(f).length, requestCount + 1);
  assert.equal(new URL(apiRequests(f).at(-1).url).pathname, '/repos/alice/project/issues/7');
  assert.equal(f.drafts.length, 0);
});

test('Local author label and search filters never fetch data and hide details that leave the results', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(1, 'Editor bug', { labels: [{ name: 'bug' }] }), issue(2, 'Design change', { user: { login: 'bob' }, labels: [{ name: 'design' }] })]);
  } });
  await f.renderReady({});
  await f.renderReady({ action: 'item:item-alice/project/1' });
  const count = f.requests.length;
  const author = await f.render({ action: 'author', values: { author: 'bob' } });
  assert.equal(author.children.length, 2);
  assert.deepEqual(Array.from(nodes(author).find(node => node.id === 'item-navigation').items, item => item.text), ['Design change']);
  const empty = await f.render({ action: 'label', values: { label: 'bug' } });
  assert.equal(nodes(empty).filter(node => node.type === 'emptyState').length, 1);
  assert.match(texts(empty), /No matching loaded items|already loaded/);
  const reset = await f.render({ action: 'clear-filters' });
  assert.equal(nodes(reset).find(node => node.id === 'item-navigation').items.length, 2);
  const query = await f.render({ action: 'query', values: { query: 'bob' } });
  assert.equal(nodes(query).find(node => node.id === 'item-navigation').items.length, 1);
  assert.equal(f.requests.length, count);
});

test('An empty GitHub view offers refresh and legacy all-states cannot retrieve closed work', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    assert.match(url.searchParams.get('q'), /(?:^| )state:open(?: |$)/);
    return searchBody([]);
  } });
  const empty = await f.renderReady({});
  assert.equal(nodes(empty).filter(node => node.type === 'emptyState').length, 1);
  assert.match(texts(empty), /No open Issues/);
  assert.match(texts(empty), /No pending work in this view/);
  assert.ok(nodes(empty).some(node => node.action === 'refresh'));
  assert.ok(!nodes(empty).some(node => node.action === 'all-states' || node.action === 'status'));
  const refreshed = await f.render({ action: 'all-states' });
  assert.equal(refreshed.children[0].items.length, 0);
  assert.match(new URL(apiRequests(f).at(-1).url).searchParams.get('q'), /(?:^| )state:open(?: |$)/);
});

test('A stale repository failure cannot replace the newest repository or its selected details', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo('alice/first'), repo('alice/second', 2)]);
    if ((url.searchParams.get('q') || '').includes('repo:alice/second')) { started.resolve(); await release.promise; return body({}, 403); }
    return itemResponse(url, [repositoryIssue(url, 1, 'Current first repository', { body: 'Current details' })]);
  } });
  await f.renderReady({});
  const older = f.render({ action: 'repository', values: { repository: 'alice/second' } });
  await started.promise;
  await f.render({ action: 'repository', values: { repository: 'alice/first' } });
  await f.renderReady({ action: 'item:item-alice/first/1' });
  release.resolve();
  const final = await older;
  assert.equal(nodes(final).find(node => node.id === 'repository').value, 'alice/first');
  assert.match(texts(final.children[1]), /Current details/);
  assert.doesNotMatch(texts(final), /denied|Couldn’t load/);
});

test('Fast Issues PR and legacy state events ignore late results and failures while retaining open scope', async () => {
  const started = deferred(), release = deferred();
  let feedRequests = 0;
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    if (++feedRequests === 2) {
      started.resolve(); await release.promise; return body({}, 404);
    }
    return itemResponse(url, [issue(1, 'Initial Issue'), issue(2, 'Current open PR', {
      pull_request: {}, html_url: 'https://github.com/alice/project/pull/2' })]);
  } });
  await f.renderReady({});
  const earlier = f.render({ action: 'kind:pulls', values: { 'view-navigation': 'view-pulls' } });
  await started.promise;
  const pending = await earlier;
  const loading = nodes(pending.children[0]).find(node => node.id === 'github-items-loading');
  assert.equal(loading.type, 'progress');
  assert.equal(loading.appearance, 'secondary');
  assert.equal(loading.text, 'Loading pull requests…');
  assert.doesNotMatch(texts(pending), /Initial Issue/);
  const latest = await f.render({ action: 'status', values: { status: 'all' } });
  assert.equal(nodes(latest).find(node => node.id === 'view-navigation').value, 'view-pulls');
  assert.match(texts(latest), /Current open PR/);
  const before = f.invalidations.length;
  release.resolve();
  await f.waitForInvalidation(before);
  const final = await f.renderReady({});
  assert.ok(!nodes(final).some(node => node.id === 'status'));
  assert.match(new URL(apiRequests(f).at(-1).url).searchParams.get('q'), /state:open/);
  assert.doesNotMatch(texts(final), /not found|Initial Issue/);
  assert.equal(nodes(final).find(node => node.id === 'item-alice/project/2').children[0].symbol, 'arrow.triangle.pull');
});

test('The current data error remains recoverable after a local search during its request', async () => {
  const started = deferred(), release = deferred();
  let fails = true, feedRequests = 0;
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    if (++feedRequests > 1 && fails) { started.resolve(); await release.promise; return body({}, 403); }
    return itemResponse(url, [issue(1, 'Recovered issue')]);
  } });
  await f.renderReady({});
  const changing = f.render({ action: 'status', values: { status: 'closed' } });
  await started.promise;
  const pending = await f.render({ action: 'query', values: { query: 'Recovered' } });
  const loading = nodes(pending.children[0]).find(node => node.id === 'github-items-loading');
  assert.equal(loading.type, 'progress');
  assert.equal(loading.appearance, 'secondary');
  assert.equal(loading.text, 'Loading Issues…');
  release.resolve();
  const failed = await changing;
  assert.match(texts(failed), /access was denied/);
  assert.ok(nodes(failed).some(node => node.action === 'retry-load'));
  fails = false;
  const recovered = await f.renderReady({ action: 'retry-load' });
  assert.match(texts(recovered), /Recovered issue/);
  assert.doesNotMatch(texts(recovered), /access was denied/);
  assert.ok(!nodes(recovered).some(node => node.id === 'status'));
  assert.match(new URL(apiRequests(f).at(-1).url).searchParams.get('q'), /state:open/);
  assert.equal(nodes(recovered).find(node => node.id === 'query').value, 'Recovered');
});

test('A transient saved-account error can retry or begin OAuth without a successful old connection', async () => {
  let fails = true;
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/login/device/code') return body(device());
    if (url.pathname === '/user') return fails ? body({}, 503) : body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return url.pathname === '/search/issues' ? searchBody([]) : body([]);
  } });
  const failed = await f.renderReady({});
  assert.equal(failed.type, 'emptyState');
  assert.ok(nodes(failed).some(node => node.action === 'retry-load'));
  fails = false;
  const recovered = await f.renderReady({ action: 'retry-load' });
  assert.equal(recovered.type, 'workspace');
  await f.render({ action: 'disconnect' });
  assert.match(texts(await f.render({ action: 'begin-login' })), /ABCD-1234/);
});

test('Paginated rows remain inside native descriptor limits with an explicit loaded-only search scope', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    const page = Number(url.searchParams.get('page'));
    return itemResponse(url, Array.from({ length: 50 }, (_, index) => issue((page - 1) * 50 + index + 1, `Issue ${(page - 1) * 50 + index + 1}`,
      { labels: [{ name: 'bug' }, { name: 'triage' }], updated_at: '2026-10-10T00:00:00Z' })), 200,
      { link: `<https://api.github.com/search/issues?page=${page + 1}>; rel="next"` });
  } });
  await f.renderReady({});
  await f.render({ action: 'more-items' });
  const view = await f.render({ action: 'more-items' });
  assert.ok(view.children[0].items.length > 0 && view.children[0].items.length <= 150);
  assert.equal(nodes(view).find(node => node.id === 'query').placeholder, 'Search loaded items');
  assert.ok(nodes(view).length <= 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(view), 'utf8') <= 512 * 1024);
  assert.match(texts(await f.render({ action: 'query', values: { query: 'Issue 150' } })), /Issue 150/);
});

test('An expired account can reconnect from its data error without restoring the old account into OAuth', async () => {
  let expired = false;
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/login/device/code') return body(device());
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return expired ? body({}, 401) : itemResponse(url, [issue(1, 'Existing issue')]);
  } });
  await f.renderReady({});
  expired = true;
  const failed = await f.render({ action: 'status', values: { status: 'closed' } });
  assert.ok(nodes(failed).some(node => node.action === 'begin-login'));
  const login = await f.render({ action: 'begin-login' });
  assert.equal(login.type, 'emptyState');
  assert.match(texts(login), /ABCD-1234/);
  assert.doesNotMatch(texts(login), /alice|Existing issue/);
  const count = f.requests.length;
  assert.match(texts(await f.render({ action: 'open-login' })), /ABCD-1234/);
  assert.equal(f.requests.length, count);
  assert.equal(f.stored(), connection);
});

test('The sidebar lists account items and repository selection narrows the existing Issues PR view', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo('alice/first'), repo('team/second', 2)]);
    const repository = /(?:^| )repo:([^ ]+)/.exec(url.searchParams.get('q') || '')?.[1] || 'team/second';
    const extra = { repository_url: `https://api.github.com/repos/${repository}`,
      html_url: `https://github.com/${repository}/pull/7`, pull_request: {} };
    const pullRequest = issue(7, `PR in ${repository}`, extra);
    if ((url.searchParams.get('q') || '').includes('is:pull-request')) return searchBody([pullRequest]);
    return itemResponse(url, [issue(1, 'First issue', { repository_url: `https://api.github.com/repos/${repository}`,
      html_url: `https://github.com/${repository}/issues/1` }), pullRequest]);
  } });
  const initial = await f.renderReady({});
  const selector = nodes(initial.children[0]).find(node => node.id === 'repository');
  assert.equal(selector.value, '');
  assert.deepEqual(Array.from(selector.options, option => option.value), ['', 'alice/first', 'team/second']);
  assert.equal(initial.children[0].items[0].text, 'First issue');
  assert.ok(!initial.children[0].items.some(item => item.text === 'alice/first' || item.text === 'team/second'));
  await f.renderReady({ action: 'kind:pulls', values: { 'view-navigation': 'view-pulls' } });
  const switched = await f.render({ action: 'repository', values: { repository: 'team/second' } });
  assert.equal(nodes(switched.children[0]).find(node => node.id === 'repository').value, 'team/second');
  assert.equal(nodes(switched.children[0]).find(node => node.id === 'view-navigation').value, 'view-pulls');
  assert.deepEqual(Array.from(switched.children[0].items, item => [item.text, item.action]),
    [['PR in team/second', 'item:item-team/second/7']]);
  assert.equal(new URL(f.requests.at(-1).url).pathname, '/search/issues');
  assert.ok(new URL(f.requests.at(-1).url).searchParams.get('q').includes('repo:team/second'));
  assert.ok(apiRequests(f).every(request => request.headers.Authorization === 'Bearer test_token'));
});

test('Repository pagination expands the optional filter without replacing the issue list', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return url.searchParams.get('page') === '2'
      ? body([repo('alice/first'), repo('team/second', 2)])
      : body([repo('alice/first')], 200, { link: '<https://api.github.com/user/repos?page=2>; rel="next"' });
    return itemResponse(url, [issue(1, 'Issue list remains visible')]);
  } });
  const initial = await f.renderReady({});
  const initialFilter = nodes(initial.children[0]).find(node => node.id === 'repository');
  assert.deepEqual(Array.from(initialFilter.options, option => option.value), ['', 'alice/first']);
  assert.equal(initialFilter.value, '');
  assert.ok(nodes(initial.children[0]).some(node => node.action === 'more-repos'));
  const requestCount = f.requests.length;
  const loaded = await f.render({ action: 'more-repos' });
  assert.deepEqual(Array.from(nodes(loaded.children[0]).find(node => node.id === 'repository').options, option => option.value),
    ['', 'alice/first', 'team/second']);
  assert.equal(loaded.children[0].items[0].text, 'Issue list remains visible');
  assert.equal(f.requests.length, requestCount + 1);
  assert.equal(new URL(f.requests.at(-1).url).pathname, '/user/repos');
  assert.ok(!nodes(loaded.children[0]).some(node => node.action === 'more-repos'));
  assert.equal(f.stored(), connection);
});

test('Hand to Nora creates a source-rich draft only from the explicit selected-detail action', async () => {
  const f = fixture({ saved: { token: 'test_token', refreshToken: 'refresh_token' }, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(42, 'Fix issue context', { body: '## Reproduction\nThe editor loses focus.', ...(url.pathname === '/search/issues' ? {} : { state: 'closed' }) })]);
  } });
  await f.renderReady({});
  assert.equal(f.drafts.length, 0);
  const selected = await f.renderReady({ action: 'item:item-alice/project/42' });
  assert.ok(nodes(selected.children[1]).some(node => node.action === 'handoff-item' && node.appearance === 'primary'));
  assert.equal(f.drafts.length, 0);
  const count = f.requests.length;
  await f.render({ action: 'handoff-item' });
  assert.equal(f.drafts.length, 1);
  const draft = f.drafts[0];
  assert.match(draft.title, /Issue #42.*Fix issue context/);
  assert.match(draft.prompt, /analyze.*GitHub Issue/);
  for (const expected of ['GitHub source', 'alice/project', 'Type: Issue', 'Number: #42', 'Fix issue context', 'Closed', 'Author: alice', '## Reproduction', 'The editor loses focus.']) assert.ok(draft.context.includes(expected), expected);
  assert.equal(draft.sourceURL, 'https://github.com/alice/project/issues/42');
  assert.ok(draft.context.includes(draft.sourceURL));
  assert.doesNotMatch(JSON.stringify(draft), /test_token|refresh_token|Authorization|Bearer/);
  assert.equal(f.requests.length, count);
  assert.equal(f.writes.length, 0);
  assert.equal(f.links.length, 0);
});

test('Nora draft context tracks the current repository PR and rejects stale or hidden selections', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo('alice/first'), repo('team/second', 2)]);
    if ((url.pathname === '/search/issues' && !(url.searchParams.get('q') || '').includes('is:pull-request'))
      || /^\/repos\/[^/]+\/[^/]+\/issues\/[1-9][0-9]*$/.test(url.pathname)) {
      return itemResponse(url, [repositoryIssue(url, 7, 'Selected issue')]);
    }
    return itemResponse(url, [issue(7, 'Selected pull request', {
      pull_request: {}, ...(url.pathname === '/search/issues' ? {} : { state: 'closed', merged_at: '2026-10-10T00:00:00Z' }),
      repository_url: 'https://api.github.com/repos/team/second', html_url: 'https://github.com/team/second/pull/7' })]);
  } });
  await f.renderReady({});
  await f.renderReady({ action: 'item:item-alice/project/7' });
  await f.render({ action: 'repository', values: { repository: 'team/second' } });
  await f.render({ action: 'handoff-item' });
  assert.equal(f.drafts.length, 0);
  await f.renderReady({ action: 'kind:pulls' });
  await f.renderReady({ action: 'item:item-team/second/7' });
  await f.render({ action: 'handoff-item' });
  assert.match(f.drafts[0].context, /Repository: team\/second\nType: PR/);
  assert.match(f.drafts[0].context, /State: Merged/);
  assert.equal(f.drafts[0].sourceURL, 'https://github.com/team/second/pull/7');
  await f.render({ action: 'close-detail' });
  await f.render({ action: 'handoff-item' });
  assert.equal(f.drafts.length, 1);
});

test('Large Unicode GitHub source becomes a bounded Nora draft with intact text and a complete source link', async () => {
  const f = fixture({ saved: connection, locale: 'zh-Hans', route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return itemResponse(url, [issue(9, '你好🧑🏽‍💻'.repeat(100), { body: '你好🧑🏽‍💻'.repeat(30_000) })]);
  } });
  await f.renderReady({});
  await f.renderReady({ action: 'item:item-alice/project/9' });
  await f.render({ action: 'handoff-item' });
  const draft = f.drafts[0];
  assert.ok(draft);
  assert.ok(Buffer.byteLength(draft.title, 'utf8') <= 256);
  assert.ok(Buffer.byteLength(draft.prompt, 'utf8') <= 4096);
  assert.ok(Buffer.byteLength(draft.context, 'utf8') <= 128 * 1024);
  assert.ok(!/[\ud800-\udbff]$/.test(draft.title));
  assert.match(draft.context, /描述已截断/);
  assert.ok(draft.context.includes(draft.sourceURL));
  assert.equal(draft.sourceURL, 'https://github.com/alice/project/issues/9');
});

test('Large repository filters and paginated issue lists remain inside native view limits', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    const page = Number(url.searchParams.get('page'));
    if (url.pathname === '/user/repos') return body(Array.from({ length: 50 }, (_, index) => repo(`alice/repo-${(page - 1) * 50 + index}`, (page - 1) * 50 + index + 1)),
      200, { link: `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"` });
    return itemResponse(url, Array.from({ length: 50 }, (_, index) => repositoryIssue(url, (page - 1) * 50 + index + 1, `Issue ${(page - 1) * 50 + index + 1}`,
      { labels: [{ name: 'bug' }, { name: 'triage' }], updated_at: '2026-10-10T00:00:00Z' })), 200,
      { link: `<https://api.github.com/search/issues?page=${page + 1}>; rel="next"` });
  } });
  await f.renderReady({});
  for (let page = 2; page <= 4; page += 1) await f.render({ action: 'more-repos' });
  await f.render({ action: 'more-items' });
  const view = await f.render({ action: 'more-items' });
  const repository = nodes(view.children[0]).find(node => node.id === 'repository');
  assert.equal(repository.options.length, 101);
  assert.equal(repository.value, '');
  assert.ok(nodes(view).length <= 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(view), 'utf8') <= 512 * 1024);
  assert.ok(view.children[0].items.length > 0 && view.children[0].items.length <= 150);
  assert.match(texts(await f.render({ action: 'query', values: { query: 'Issue 150' } })), /Issue 150/);
  assert.ok(!repository.options.some(option => option.value === 'alice/repo-0'));
  await f.render({ action: 'show-other-repo' });
  const manual = await f.render({ action: 'open-repo', values: { 'manual-repo': 'alice/repo-0' } });
  const manualFilter = nodes(manual.children[0]).find(node => node.id === 'repository');
  assert.equal(manualFilter.value, 'alice/repo-0');
  assert.ok(manualFilter.options.some(option => option.value === 'alice/repo-0'));
  assert.ok(manual.children[0].items.every(item => item.id.startsWith('item-alice/repo-0/')));
  assert.equal(new URL(f.requests.at(-1).url).pathname, '/search/issues');
  assert.ok(new URL(f.requests.at(-1).url).searchParams.get('q').includes('repo:alice/repo-0'));
  assert.ok(nodes(manual).length <= 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(manual), 'utf8') <= 512 * 1024);
  assert.equal(f.stored(), connection);
  assert.equal(f.writes.length, 0);
});

test('Handoff requires the current explicit action capability and never saves that capability as content', async () => {
  const f = fixture({ saved: connection });
  await f.renderReady({});
  await f.renderReady({ action: 'item:item-alice/project/1' });
  const missing = await f.renderUnscoped({ action: 'handoff-item' });
  assert.match(texts(missing), /requires an explicit panel action/);
  assert.equal(f.drafts.length, 0);
  const expired = await f.renderUnscoped({ action: 'handoff-item', actionCapability: randomUUID() });
  assert.match(texts(expired), /action scope expired/);
  assert.equal(f.drafts.length, 0);
  const completed = await f.render({ action: 'handoff-item' });
  assert.equal(f.drafts.length, 1);
  assert.equal(f.drafts[0].actionCapability, undefined);
  assert.doesNotMatch(JSON.stringify(completed), /actionCapability/);
  assert.doesNotMatch(JSON.stringify(f.drafts[0]), /actionCapability/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.stored(), connection);
});

test('Background draft calls cannot borrow an unrelated action that is still loading', async () => {
  const started = deferred(), release = deferred();
  let waits = false;
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') {
      if (waits) { started.resolve(); await release.promise; }
      return body([repo()]);
    }
    return itemResponse(url, [issue(1, 'Issue one')]);
  } });
  await f.renderReady({});
  waits = true;
  const refreshing = f.render({ action: 'refresh' });
  await started.promise;
  const draft = { title: 'Background draft', prompt: 'This must not open', context: '' };
  for (const event of [undefined, {}, { action: 'handoff-item' }, { actionCapability: randomUUID() }]) {
    await assert.rejects(f.requestDraft(draft, event), /requires an explicit panel action/);
  }
  assert.equal(f.drafts.length, 0);
  release.resolve();
  await refreshing;
  assert.equal(f.drafts.length, 0);
});
