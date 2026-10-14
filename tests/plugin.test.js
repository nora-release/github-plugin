import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const plugin = await fs.readFile(new URL('../plugin.js', import.meta.url), 'utf8');
const sdkPath = process.env.NORA_PLUGIN_KIT_PATH
  ? `${process.env.NORA_PLUGIN_KIT_PATH}/Sources/NoraPluginKit/Resources/script-api.js`
  : new URL('../node_modules/@nora/plugin-kit/Sources/NoraPluginKit/Resources/script-api.js', import.meta.url);
const sdk = (await fs.readFile(sdkPath, 'utf8')).replace('export default function', 'function');
const body = (data, status = 200, headers = {}) => ({ status, headers, bodyText: JSON.stringify(data) });
const repo = (name = 'alice/project', id = 1) => ({ id, full_name: name, private: true });
const issue = (number, title, extra = {}) => ({ id: number, number, title, body: 'Description', state: 'open', user: { login: 'alice' }, html_url: `https://github.com/alice/project/issues/${number}`, ...extra });
const nodes = view => [view, ...(view.children || []).flatMap(nodes), ...(view.items || []).flatMap(nodes)];
const texts = view => nodes(view).flatMap(node => [node.text, node.subtitle].filter(Boolean)).join('\n');
function fixture({ saved = null, locale = 'en', now = () => Date.now(), beforeSave = async () => {}, route = async url => {
  if (url.pathname === '/user') return body({ login: 'alice' });
  if (url.pathname === '/user/repos') return body([repo()]);
  return body([issue(1, 'Issue one')]);
} } = {}) {
  let stored = saved;
  const actionCapabilities = new Set();
  const requests = [], writes = [], links = [], drafts = [];
  const request = async (method, args) => {
    if (method === 'credentials.get') return stored;
    if (method === 'credentials.set') { await beforeSave(args.value); stored = args.value; writes.push(stored); return null; }
    if (method === 'credentials.delete') { stored = null; return null; }
    if (method === 'browser.open') { links.push(args.url); return true; }
    if (method === 'chat.openDraft') {
      if (!actionCapabilities.has(args.actionCapability)) throw new Error('The draft action scope expired.');
      const { actionCapability, ...draft } = args;
      drafts.push(draft);
      return true;
    }
    if (method === 'network.request') { requests.push(args); return route(new URL(args.url), args); }
    throw new Error(`Unexpected method: ${method}`);
  };
  class ClockDate extends Date { static now() { return now(); } }
  const context = vm.createContext({ request, locale, Date: ClockDate });
  vm.runInContext(`${sdk}\nglobalThis.api = createNoraPluginAPI(request, locale);\n${plugin}`, context);
  const render = async (event = {}) => {
    const actionCapability = typeof event.action === 'string' && event.action.trim() ? randomUUID() : undefined;
    if (actionCapability) actionCapabilities.add(actionCapability);
    try {
      return await context.api.invokePanel('com.nora.github.panel', { ...event, actionCapability });
    } finally {
      if (actionCapability) actionCapabilities.delete(actionCapability);
    }
  };
  return {
    render,
    renderUnscoped: event => context.api.invokePanel('com.nora.github.panel', event),
    requestDraft: (draft, event) => context.nora.chat.openDraft(draft, event),
    command: (id, args = {}) => context.api.invokeCommand(`com.nora.github.${id}`, args),
    requests, writes, links, drafts, stored: () => stored,
  };
}
const connection = { token: 'test_token' };
const avatarPNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const avatarJPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=';
const accountHeader = view => view.children[0].children[0];
const avatarResponse = (bodyBase64 = avatarPNG, status = 200, contentType = 'image/png') => ({
  status, headers: { 'content-type': contentType }, bodyBase64,
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
    return body([issue(1, 'Issue one')]);
  } });
  const view = await f.render({});
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

test('Missing or untrusted avatar URLs keep the account placeholder without requesting another website', async () => {
  for (const avatarURL of [undefined, '', 'http://avatars.githubusercontent.com/u/1',
    'https://github.com/u/1', 'https://avatars.githubusercontent.com.evil.test/u/1',
    'https://name:secret@avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com:444/u/1',
    'https://avatars.githubusercontent.com/u/1#fragment', 'https://avatars.githubusercontent.com\\@evil.test/u/1']) {
    const f = fixture({ saved: connection, route: async url => {
      if (url.pathname === '/user') return body({ login: 'alice', avatar_url: avatarURL });
      if (url.pathname === '/user/repos') return body([repo()]);
      return body([issue(1, 'Issue one')]);
    } });
    const view = await f.render({});
    assert.equal(accountHeader(view).text, 'alice');
    assert.equal(accountHeader(view).symbol, 'person.crop.circle');
    assert.equal(accountHeader(view).avatarBase64, undefined);
    assert.match(texts(view), /Issue one/);
    assert.equal(f.requests.filter(request => request.responseEncoding === 'base64').length, 0);
    assert.ok(f.requests.every(request => new URL(request.url).hostname === 'api.github.com'));
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
      return body([issue(1, 'Issue one')]);
    } });
    const view = await f.render({});
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
    return body([issue(1, 'Issue one')]);
  } });
  for (const event of [{}, { action: 'query', values: { query: 'Issue' } },
    { action: 'refresh-repos' }, { action: 'kind:pulls' }, { action: 'refresh' }]) {
    assert.equal(accountHeader(await f.render(event)).avatarBase64, avatarJPEG);
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
    return body([issue(1, 'Issue one')]);
  } });
  const connecting = f.render({ action: 'connect-token', values: { token: 'test_token' } });
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(repositoriesLoaded, true);
  release.resolve();
  const view = await connecting;
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
    return body([issue(1, 'Issue one')]);
  } });
  await f.render({ action: 'begin-login' });
  now = 6000;
  const view = await f.render({ action: 'finish-login' });
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
    return body([issue(1, 'Issue one')]);
  } });
  const older = f.render({ action: 'connect-token', values: { token: 'older_token' } });
  await started.promise;
  const current = await f.render({ action: 'connect-token', values: { token: 'newer_token' } });
  assert.equal(accountHeader(current).text, 'bob');
  assert.equal(accountHeader(current).avatarBase64, avatarJPEG);
  release.resolve();
  const late = await older;
  assert.equal(accountHeader(late).text, 'bob');
  assert.equal(accountHeader(late).avatarBase64, avatarJPEG);
  assert.equal(JSON.parse(f.stored()).token, 'newer_token');
  assert.equal(f.requests.filter(request => request.responseEncoding === 'base64').length, 2);
});

test('Disconnect clears the avatar and a new connection fetches its own copy', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
    if (url.hostname === 'avatars.githubusercontent.com') return avatarResponse();
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([issue(1, 'Issue one')]);
  } });
  assert.equal(accountHeader(await f.render({})).avatarBase64, avatarPNG);
  const disconnected = await f.render({ action: 'disconnect' });
  assert.equal(disconnected.type, 'emptyState');
  assert.ok(nodes(disconnected).every(node => node.avatarBase64 === undefined));
  assert.equal(f.stored(), null);
  assert.equal(accountHeader(await f.render({ action: 'connect-token', values: { token: 'new_token' } })).avatarBase64, avatarPNG);
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
  const view = await f.render({});
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
  const view = await fixture({ locale: 'zh-Hans' }).render({});
  assert.match(texts(view), /连接你自己的账号/);
  assert.match(texts(view), /管理仓库访问权限/);
  assert.ok(nodes(view).every(node => !['html', 'webview'].includes(node.type)));
});
test('Repos and Issues are read under the connected user credentials', async () => {
  const f = fixture({ saved: JSON.stringify(connection) });
  const view = await f.render({});
  assert.match(texts(view), /alice/);
  assert.match(texts(view), /Issue one/);
  assert.ok(f.requests.every(request => request.headers.Authorization === 'Bearer test_token'));
  assert.ok(nodes(view).find(node => node.id === 'repository-navigation').items.some(item => item.text === 'alice/project'));
});
test('Issues exclude PRs and the PR view exposes draft and merged states', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    if (url.pathname.endsWith('/issues')) return body([issue(1, 'Real issue'), issue(2, 'Not an issue', { pull_request: {} })]);
    return body([issue(3, 'Work in progress', { draft: true }), issue(4, 'Finished', { merged_at: '2026-10-01T00:00:00Z' })]);
  } });
  assert.doesNotMatch(texts(await f.render({})), /Not an issue/);
  const view = await f.render({ action: 'kind', values: { kind: 'pulls' } });
  assert.match(texts(view), /Draft/);
  assert.match(texts(view), /Merged/);
});
test('Invalid PAT never overwrites saved credentials', async () => {
  const f = fixture({ saved: connection, route: async (url, args) => {
    if (args.headers.Authorization === 'Bearer invalid_token') return body({}, 401);
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([]);
  } });
  const view = await f.render({ action: 'connect-token', values: { token: 'invalid_token' } });
  assert.match(texts(view), /expired/);
  assert.equal(f.stored(), connection);
  assert.equal(f.writes.length, 0);
});
test('The native filter and issue details operate without more network requests', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([issue(1, 'Alpha'), issue(2, 'Beta')]);
  } });
  await f.render({});
  const before = f.requests.length;
  const view = await f.render({ action: 'query', values: { query: 'Beta' } });
  assert.doesNotMatch(texts(view), /Alpha/);
  assert.match(texts(view), /Beta/);
  const detail = await f.render({ action: 'item:2' });
  assert.match(texts(detail), /Description/);
  assert.equal(f.requests.length, before);
  await f.render({ action: 'open-item' });
  assert.deepEqual(f.links, ['https://github.com/alice/project/issues/2']);
});
test('Page loading deduplicates and commands validate untrusted repository inputs', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return url.searchParams.get('page') === '2' ? body([issue(1, 'Alpha'), issue(2, 'Beta')]) : body([issue(1, 'Alpha')], 200, { link: '<https://api.github.com/repos/alice/project/issues?page=2>; rel="next"' });
  } });
  await f.render({});
  const view = await f.render({ action: 'more-items' });
  assert.equal(nodes(view).filter(node => node.id === 'item-1').length, 1);
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
    return body([]);
  } });
  const restore = f.render({});
  await pending;
  await f.render({ action: 'disconnect' });
  release();
  const view = await restore;
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
    return body([]);
  } });
  const older = f.render({ action: 'connect-token', values: { token: 'older_token' } });
  await started.promise;
  const current = await f.render({ action: 'connect-token', values: { token: 'newer_token' } });
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
    return body([]);
  } });
  const older = f.render({ action: 'connect-token', values: { token: 'older_token' } });
  await started.promise;
  const newer = f.render({ action: 'connect-token', values: { token: 'newer_token' } });
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
    if (url.pathname.includes('/second/')) { started.resolve(); await release.promise; return body([issue(2, 'Stale second result')]); }
    return body([issue(1, 'First result', { body: 'Old selected details' })]);
  } });
  await f.render({});
  await f.render({ action: 'item:1' });
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
    return body([]);
  } });
  await f.render({ action: 'begin-login' });
  assert.match(texts(await f.render({ action: 'finish-login' })), /few seconds/);
  assert.equal(polls, 0);
  time += 5000;
  assert.match(texts(await f.render({ action: 'finish-login' })), /Waiting for your confirmation/);
  assert.equal(f.writes.length, 0);
  time += 5000;
  const connected = await f.render({ action: 'finish-login' });
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
    return body([]);
  } });
  const oldConnection = f.render({ action: 'connect-token', values: { token: 'test_token' } });
  await started.promise;
  const disconnecting = f.render({ action: 'disconnect' });
  await f.render({ action: 'begin-login' });
  release.resolve();
  await Promise.all([oldConnection, disconnecting]);
  assert.equal(f.stored(), null);
});

test('Oversized Unicode descriptions stay within native view limits and retain the full GitHub link', async () => {
  const description = '你好🧑🏽‍💻'.repeat(20_000);
  const f = fixture({ saved: connection, locale: 'zh-Hans', route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([issue(1, 'Large description', { body: description })]);
  } });
  await f.render({});
  const detail = await f.render({ action: 'item:1' });
  const descriptionNode = nodes(detail).find(node => node.text?.includes('描述过长已截断'));
  assert.ok(descriptionNode);
  assert.ok(Buffer.byteLength(descriptionNode.text, 'utf8') <= 64 * 1024);
  assert.ok(!/[\ud800-\udbff]$/.test(descriptionNode.text));
  assert.ok(nodes(detail).every(node => !node.text || Buffer.byteLength(node.text, 'utf8') <= 64 * 1024));
  assert.ok(Buffer.byteLength(JSON.stringify(detail), 'utf8') <= 512 * 1024);
  assert.ok(nodes(detail).some(node => node.action === 'open-item'));
  await f.render({ action: 'open-item' });
  assert.deepEqual(f.links, ['https://github.com/alice/project/issues/1']);
});

test('A native workspace keeps list metadata compact and selected details in its inspector', async () => {
  const f = fixture({ saved: connection, now: () => Date.parse('2026-10-12T00:00:00Z'), route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([issue(1, 'Fix the editor', { updated_at: '2026-10-10T10:00:00Z', labels: [{ name: 'bug' }], body: '## Details\nA real description.' })]);
  } });
  const initial = await f.render({});
  assert.equal(initial.type, 'workspace');
  assert.equal(initial.children[0].type, 'sidebar');
  assert.equal(initial.children[0].value, 'repo-alice/project');
  const viewNavigation = nodes(initial.children[0]).find(node => node.id === 'view-navigation');
  assert.equal(viewNavigation.value, 'view-issues');
  assert.deepEqual(Array.from(viewNavigation.items, item => item.action), ['kind:issues', 'kind:pulls']);
  assert.equal(initial.children.length, 2);
  const collection = nodes(initial).find(node => node.id === 'items');
  assert.equal(collection.type, 'collection');
  assert.equal(collection.action, 'peek-item');
  const item = collection.items[0];
  assert.equal(item.type, 'collectionItem');
  assert.equal(item.text, 'Fix the editor');
  assert.equal(item.subtitle, '#1');
  assert.equal(item.tone, 'success');
  assert.match(texts(item), /alice\nOct 10\nbug/);
  const count = f.requests.length;
  const selected = await f.render({ action: 'item:1', values: { items: 'item-1' } });
  assert.equal(selected.children.length, 3);
  assert.equal(selected.children[2].id, 'item-details');
  assert.ok(nodes(selected.children[2]).some(node => node.type === 'markdown' && node.text.includes('A real description.')));
  assert.ok(!nodes(selected.children[1]).some(node => node.type === 'markdown'));
  const closed = await f.render({ action: 'close-detail', values: { 'github-workspace': '' } });
  assert.equal(closed.children.length, 2);
  assert.equal(nodes(closed).find(node => node.id === 'items').value, 'item-1');
  assert.equal((await f.render({ action: 'peek-item', values: { items: 'item-1' } })).children.length, 3);
  assert.equal((await f.render({ action: 'peek-item', values: { items: 'item-1' } })).children.length, 2);
  assert.equal(f.requests.length, count);
});

test('Account and repository utilities stay in menus and manual repository entry is an explicit operation', async () => {
  const f = fixture({ saved: connection });
  const view = await f.render({});
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
  assert.equal(new URL(f.requests.at(-1).url).pathname, '/repos/bob/other/issues');
});

test('One workspace toolbar keeps repository context search and filters while account actions stay in the sidebar', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([issue(1, 'Editor fix'), issue(2, 'Settings fix', { user: { login: 'bob' } })]);
  } });
  const initial = await f.render({});
  const [sidebar, main] = initial.children;
  const toolbar = main.children[0];
  assert.equal(main.children.filter(node => node.type === 'toolbar').length, 1);
  assert.equal(toolbar.type, 'toolbar');
  assert.match(texts(toolbar), /alice\/project\nIssues/);
  assert.equal(nodes(toolbar).find(node => node.text === 'alice/project').textStyle, 'caption');
  assert.equal(nodes(toolbar).find(node => node.text === 'Issues').textStyle, 'headline');
  assert.ok(nodes(toolbar).some(node => node.id === 'query' && node.placeholder === 'Search loaded items'));
  assert.ok(nodes(toolbar).some(node => node.id === 'status' && node.action === 'status'));
  assert.ok(nodes(toolbar).some(node => node.action === 'refresh'));
  assert.ok(!nodes(main).some(node => node.action === 'disconnect' || node.action === 'show-other-repo'));
  assert.doesNotMatch(texts(main), /\d+ of \d+ loaded/);
  assert.equal(sidebar.children[0].type, 'menu');
  const account = sidebar.children[0];
  assert.equal(account.text, 'alice');
  assert.notEqual(account.appearance, 'icon');
  for (const action of ['show-other-repo', 'manage', 'refresh-repos', 'disconnect']) {
    assert.ok(nodes(account).some(node => node.action === action), action);
  }
  assert.ok(nodes(sidebar).some(node => node.id === 'repo-query' && node.symbol === 'magnifyingglass'));
  assert.equal(sidebar.children.filter(node => node.type === 'divider').length, 0);
  const requestCount = f.requests.length;
  const filtered = await f.render({ action: 'author', values: { author: 'bob' } });
  assert.deepEqual(Array.from(nodes(filtered).find(node => node.id === 'items').items, item => item.text), ['Settings fix']);
  assert.match(texts(filtered.children[1].children[0]), /Open · 1 filter/);
  assert.equal(f.requests.length, requestCount);
  const switched = await f.render({ action: 'kind:pulls' });
  assert.match(texts(switched.children[1].children[0]), /alice\/project\nPull requests/);
  assert.equal(new URL(f.requests.at(-1).url).pathname, '/repos/alice/project/pulls');
  assert.equal(f.stored(), connection);
  assert.equal(f.writes.length, 0);
});

test('A selected PR has one detail header and a complete Markdown description before an explicit Nora handoff', async () => {
  const f = fixture({ saved: connection, now: () => Date.parse('2026-10-12T00:00:00Z'), route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([issue(42, 'Keep the editor selection when switching pages', {
      state: 'closed', merged_at: '2026-10-10T10:00:00Z', updated_at: '2026-10-10T10:00:00Z',
      user: { login: 'bob' }, labels: [{ name: 'native' }, { name: 'reviewed' }],
      html_url: 'https://github.com/alice/project/pull/42', body: '## Changes\nPreserve the selection.\n\n- Keep keyboard focus.'
    })]);
  } });
  await f.render({});
  await f.render({ action: 'kind:pulls' });
  const requestCount = f.requests.length;
  const selected = await f.render({ action: 'item:42' });
  const detail = selected.children[2];
  assert.equal(detail.id, 'item-details');
  assert.equal(detail.children[0].type, 'toolbar');
  assert.equal(nodes(detail).filter(node => node.type === 'toolbar').length, 1);
  assert.match(texts(detail.children[0]), /PR #42\nMerged/);
  assert.equal(nodes(detail).filter(node => node.type === 'badge' && node.text === 'Merged').length, 1);
  const title = nodes(detail).find(node => node.textStyle === 'title');
  assert.equal(title.text, 'Keep the editor selection when switching pages');
  assert.ok(!nodes(detail.children[0]).includes(title));
  assert.match(texts(detail), /bob · Oct 10\nnative · reviewed/);
  assert.equal(nodes(detail).find(node => node.type === 'markdown').text, '## Changes\nPreserve the selection.\n\n- Keep keyboard focus.');
  assert.ok(nodes(detail).some(node => node.action === 'handoff-item' && node.appearance === 'primary'));
  assert.equal(f.drafts.length, 0);
  await f.render({ action: 'handoff-item' });
  assert.equal(f.drafts.length, 1);
  assert.match(f.drafts[0].context, /Repository: alice\/project\nType: PR\nNumber: #42/);
  assert.match(f.drafts[0].context, /State: Merged\nAuthor: bob/);
  assert.ok(f.drafts[0].context.includes('## Changes\nPreserve the selection.\n\n- Keep keyboard focus.'));
  assert.equal(f.drafts[0].sourceURL, 'https://github.com/alice/project/pull/42');
  assert.doesNotMatch(JSON.stringify(f.drafts[0]), /test_token|Authorization|actionCapability/);
  assert.equal(f.requests.length, requestCount);
  assert.equal(f.stored(), connection);
  assert.equal(f.writes.length, 0);
});

test('List author and date stay separate while the inspector retains labels beyond the first list badge', async () => {
  const labels = Array.from({ length: 12 }, (_, index) => ({ name: `label-${index + 1}` }));
  const f = fixture({ saved: connection, now: () => Date.parse('2026-10-12T00:00:00Z'), route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([issue(7, 'Keep all review labels', { user: { login: 'a-long-repository-author' },
      updated_at: '2026-10-10T10:00:00Z', labels })]);
  } });
  const initial = await f.render({});
  const item = nodes(initial).find(node => node.id === 'item-7');
  assert.deepEqual(Array.from(item.children, node => [node.type, node.text]), [
    ['badge', 'Open'], ['text', 'a-long-repository-author'], ['text', 'Oct 10'], ['badge', 'label-1']
  ]);
  assert.ok(item.children.every(node => node.type !== 'text' || node.textStyle === 'caption'));
  const requestCount = f.requests.length;
  const detail = (await f.render({ action: 'item:7' })).children[2];
  const detailLabels = nodes(detail).find(node => node.text === labels.map(label => label.name).join(' · '));
  assert.ok(detailLabels);
  assert.equal(detailLabels.textStyle, 'caption');
  assert.equal(f.requests.length, requestCount);
  assert.equal(f.drafts.length, 0);
});

test('Local author label and search filters never fetch data and hide details that leave the results', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([issue(1, 'Editor bug', { labels: [{ name: 'bug' }] }), issue(2, 'Design change', { user: { login: 'bob' }, labels: [{ name: 'design' }] })]);
  } });
  await f.render({});
  await f.render({ action: 'item:1' });
  const count = f.requests.length;
  const author = await f.render({ action: 'author', values: { author: 'bob' } });
  assert.equal(author.children.length, 2);
  assert.deepEqual(Array.from(nodes(author).find(node => node.id === 'items').items, item => item.text), ['Design change']);
  const empty = await f.render({ action: 'label', values: { label: 'bug' } });
  assert.equal(nodes(empty).filter(node => node.type === 'emptyState').length, 1);
  assert.match(texts(empty), /No matching loaded items|already loaded/);
  const reset = await f.render({ action: 'clear-filters' });
  assert.equal(nodes(reset).find(node => node.id === 'items').items.length, 2);
  const query = await f.render({ action: 'query', values: { query: 'bob' } });
  assert.equal(nodes(query).find(node => node.id === 'items').items.length, 1);
  assert.equal(f.requests.length, count);
});

test('An empty GitHub view has one recovery state and changing API state retrieves real closed items', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body(url.searchParams.get('state') === 'all' ? [issue(1, 'A closed issue', { state: 'closed' })] : []);
  } });
  const empty = await f.render({});
  assert.equal(nodes(empty).filter(node => node.type === 'emptyState').length, 1);
  assert.ok(nodes(empty).some(node => node.action === 'all-states'));
  const all = await f.render({ action: 'all-states' });
  assert.match(texts(all), /A closed issue/);
  assert.equal(new URL(f.requests.at(-1).url).searchParams.get('state'), 'all');
  const item = nodes(all).find(node => node.id === 'item-1');
  assert.equal(item.symbol, 'checkmark.circle');
  assert.ok(item.children.some(node => node.type === 'badge' && node.text === 'Closed'));
});

test('A stale repository failure cannot replace the newest repository or its selected details', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo('alice/first'), repo('alice/second', 2)]);
    if (url.pathname.includes('/second/')) { started.resolve(); await release.promise; return body({}, 403); }
    return body([issue(1, 'Current first repository', { body: 'Current details' })]);
  } });
  await f.render({});
  const older = f.render({ action: 'repository', values: { repository: 'alice/second' } });
  await started.promise;
  await f.render({ action: 'repository', values: { repository: 'alice/first' } });
  await f.render({ action: 'item:1' });
  release.resolve();
  const final = await older;
  assert.equal(nodes(final).find(node => node.id === 'repository-navigation').value, 'repo-alice/first');
  assert.match(texts(final.children[2]), /Current details/);
  assert.doesNotMatch(texts(final), /denied|Couldn’t load/);
});

test('Fast Issues PR and state changes ignore late results and failures from the previous view', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    if (url.pathname.endsWith('/pulls') && url.searchParams.get('state') === 'open') {
      started.resolve(); await release.promise; return body({}, 404);
    }
    return body([issue(1, url.pathname.endsWith('/pulls') ? 'Merged current PR' : 'Initial Issue', { merged_at: url.pathname.endsWith('/pulls') ? '2026-10-10T00:00:00Z' : null })]);
  } });
  await f.render({});
  const earlier = f.render({ action: 'kind:pulls', values: { 'view-navigation': 'view-pulls' } });
  await started.promise;
  const latest = await f.render({ action: 'status', values: { status: 'all' } });
  assert.equal(nodes(latest).find(node => node.id === 'view-navigation').value, 'view-pulls');
  assert.match(texts(latest), /Merged current PR/);
  release.resolve();
  const final = await earlier;
  assert.equal(nodes(final).find(node => node.id === 'status').value, 'all');
  assert.doesNotMatch(texts(final), /not found|Initial Issue/);
  assert.equal(nodes(final).find(node => node.id === 'item-1').symbol, 'arrow.triangle.merge');
});

test('The current data error remains recoverable after a local search during its request', async () => {
  const started = deferred(), release = deferred();
  let fails = true;
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    if (url.searchParams.get('state') === 'closed' && fails) { started.resolve(); await release.promise; return body({}, 403); }
    return body([issue(1, 'Recovered issue', { state: url.searchParams.get('state') })]);
  } });
  await f.render({});
  const changing = f.render({ action: 'status', values: { status: 'closed' } });
  await started.promise;
  const pending = await f.render({ action: 'query', values: { query: 'Recovered' } });
  assert.match(texts(pending), /Loading from GitHub/);
  release.resolve();
  const failed = await changing;
  assert.match(texts(failed), /access was denied/);
  assert.ok(nodes(failed).some(node => node.action === 'retry-load'));
  fails = false;
  const recovered = await f.render({ action: 'retry-load' });
  assert.match(texts(recovered), /Recovered issue/);
  assert.doesNotMatch(texts(recovered), /access was denied/);
  assert.equal(nodes(recovered).find(node => node.id === 'status').value, 'closed');
  assert.equal(nodes(recovered).find(node => node.id === 'query').value, 'Recovered');
});

test('A transient saved-account error can retry or begin OAuth without a successful old connection', async () => {
  let fails = true;
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/login/device/code') return body(device());
    if (url.pathname === '/user') return fails ? body({}, 503) : body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([]);
  } });
  const failed = await f.render({});
  assert.equal(failed.type, 'emptyState');
  assert.ok(nodes(failed).some(node => node.action === 'retry-load'));
  fails = false;
  const recovered = await f.render({ action: 'retry-load' });
  assert.equal(recovered.type, 'workspace');
  await f.render({ action: 'disconnect' });
  assert.match(texts(await f.render({ action: 'begin-login' })), /ABCD-1234/);
});

test('Paginated rows remain inside native descriptor limits with an explicit loaded-only search scope', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    const page = Number(url.searchParams.get('page'));
    return body(Array.from({ length: 50 }, (_, index) => issue((page - 1) * 50 + index + 1, `Issue ${(page - 1) * 50 + index + 1}`,
      { labels: [{ name: 'bug' }, { name: 'triage' }], updated_at: '2026-10-10T00:00:00Z' })), 200,
      { link: `<https://api.github.com/repos/alice/project/issues?page=${page + 1}>; rel="next"` });
  } });
  await f.render({});
  await f.render({ action: 'more-items' });
  const view = await f.render({ action: 'more-items' });
  assert.equal(nodes(view).find(node => node.id === 'items').items.length, 120);
  assert.match(texts(view), /120 of 150 loaded|first 120 matches/);
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
    return expired ? body({}, 401) : body([issue(1, 'Existing issue')]);
  } });
  await f.render({});
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

test('The sidebar shows real accessible repositories with independent Issues and PR navigation', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo('alice/first'), repo('team/second', 2)]);
    return body([issue(1, `${url.pathname.endsWith('/pulls') ? 'PR' : 'Issue'} in ${url.pathname}`)]);
  } });
  const initial = await f.render({});
  const repositories = nodes(initial).find(node => node.id === 'repository-navigation');
  assert.equal(repositories.type, 'sidebar');
  assert.deepEqual(Array.from(repositories.items, item => [item.text, item.action]),
    [['alice/first', 'repo:alice/first'], ['team/second', 'repo:team/second']]);
  assert.equal(nodes(repositories).find(node => node.id === 'repo-query').placeholder, 'Search loaded repositories');
  await f.render({ action: 'kind:pulls', values: { 'view-navigation': 'view-pulls' } });
  const switched = await f.render({ action: 'repo:team/second', values: { 'repository-navigation': 'repo-team/second' } });
  assert.equal(nodes(switched).find(node => node.id === 'repository-navigation').value, 'repo-team/second');
  assert.equal(nodes(switched).find(node => node.id === 'view-navigation').value, 'view-pulls');
  assert.match(texts(switched), /PR in \/repos\/team\/second\/pulls/);
  assert.ok(f.requests.every(request => request.headers.Authorization === 'Bearer test_token'));
});

test('Repository pagination and local repository search disclose exactly what has loaded', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return url.searchParams.get('page') === '2'
      ? body([repo('alice/first'), repo('team/second', 2)])
      : body([repo('alice/first')], 200, { link: '<https://api.github.com/user/repos?page=2>; rel="next"' });
    return body([]);
  } });
  const initial = await f.render({});
  assert.equal(nodes(initial).find(node => node.id === 'repository-navigation').items.length, 1);
  assert.equal(nodes(initial.children[0]).find(node => node.id === 'repo-query').placeholder, 'Search loaded repositories');
  assert.ok(nodes(initial.children[0]).some(node => node.action === 'more-repos'));
  const loaded = await f.render({ action: 'more-repos' });
  assert.equal(nodes(loaded).find(node => node.id === 'repository-navigation').items.length, 2);
  assert.doesNotMatch(texts(loaded.children[0]), /repositories loaded/);
  assert.ok(!nodes(loaded.children[0]).some(node => node.action === 'more-repos'));
  const count = f.requests.length;
  const searched = await f.render({ action: 'repo-query', values: { 'repo-query': 'team' } });
  assert.deepEqual(Array.from(nodes(searched).find(node => node.id === 'repository-navigation').items, item => item.text), ['team/second']);
  assert.equal(f.requests.length, count);
  assert.ok(nodes(searched).find(node => node.id === 'repo-query'));
  const cleared = await f.render({ action: 'repo-query', values: { 'repo-query': '' } });
  assert.equal(nodes(cleared).find(node => node.id === 'repository-navigation').items.length, 2);
});

test('Hand to Nora creates a source-rich draft only from the explicit selected-detail action', async () => {
  const f = fixture({ saved: { token: 'test_token', refreshToken: 'refresh_token' }, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    return body([issue(42, 'Fix issue context', { body: '## Reproduction\nThe editor loses focus.', state: 'closed' })]);
  } });
  await f.render({});
  assert.equal(f.drafts.length, 0);
  const selected = await f.render({ action: 'item:42' });
  assert.ok(nodes(selected.children[2]).some(node => node.action === 'handoff-item' && node.appearance === 'primary'));
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

test('Nora draft context tracks the current PR and rejects stale or hidden selections', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo('alice/first'), repo('team/second', 2)]);
    return body([issue(7, 'Selected pull request', { merged_at: '2026-10-10T00:00:00Z', html_url: 'https://github.com/team/second/pull/7' })]);
  } });
  await f.render({});
  await f.render({ action: 'item:7' });
  await f.render({ action: 'repo:team/second' });
  await f.render({ action: 'handoff-item' });
  assert.equal(f.drafts.length, 0);
  await f.render({ action: 'kind:pulls' });
  await f.render({ action: 'item:7' });
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
    return body([issue(9, '你好🧑🏽‍💻'.repeat(100), { body: '你好🧑🏽‍💻'.repeat(30_000) })]);
  } });
  await f.render({});
  await f.render({ action: 'item:9' });
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

test('Repository rows and issue metadata remain bounded when many repository pages are loaded', async () => {
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    const page = Number(url.searchParams.get('page'));
    if (url.pathname === '/user/repos') return body(Array.from({ length: 50 }, (_, index) => repo(`alice/repo-${(page - 1) * 50 + index}`, (page - 1) * 50 + index + 1)),
      200, { link: `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"` });
    return body(Array.from({ length: 50 }, (_, index) => issue((page - 1) * 50 + index + 1, `Issue ${index}`,
      { labels: [{ name: 'bug' }, { name: 'triage' }], updated_at: '2026-10-10T00:00:00Z' })), 200,
      { link: `<https://api.github.com/repos/alice/repo-0/issues?page=${page + 1}>; rel="next"` });
  } });
  await f.render({});
  for (let page = 2; page <= 4; page += 1) await f.render({ action: 'more-repos' });
  await f.render({ action: 'more-items' });
  const view = await f.render({ action: 'more-items' });
  assert.equal(nodes(view).find(node => node.id === 'repository-navigation').items.length, 200);
  assert.ok(nodes(view).length <= 1000);
  assert.equal(nodes(view).find(node => node.id === 'repo-query').placeholder, 'Search loaded repositories');
  assert.ok(nodes(view).find(node => node.id === 'items').items.length < 120);
});

test('Handoff requires the current explicit action capability and never saves that capability as content', async () => {
  const f = fixture({ saved: connection });
  await f.render({});
  await f.render({ action: 'item:1' });
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
    return body([issue(1, 'Issue one')]);
  } });
  await f.render({});
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
