import assert from 'node:assert/strict';
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
const texts = view => nodes(view).map(node => node.text || '').join('\n');
function fixture({ saved = null, locale = 'en', now = () => Date.now(), beforeSave = async () => {}, route = async url => {
  if (url.pathname === '/user') return body({ login: 'alice' });
  if (url.pathname === '/user/repos') return body([repo()]);
  return body([issue(1, 'Issue one')]);
} } = {}) {
  let stored = saved;
  const requests = [], writes = [], links = [];
  const request = async (method, args) => {
    if (method === 'credentials.get') return stored;
    if (method === 'credentials.set') { await beforeSave(args.value); stored = args.value; writes.push(stored); return null; }
    if (method === 'credentials.delete') { stored = null; return null; }
    if (method === 'browser.open') { links.push(args.url); return true; }
    if (method === 'network.request') { requests.push(args); return route(new URL(args.url), args); }
    throw new Error(`Unexpected method: ${method}`);
  };
  class ClockDate extends Date { static now() { return now(); } }
  const context = vm.createContext({ request, locale, Date: ClockDate });
  vm.runInContext(`${sdk}\nglobalThis.api = createNoraPluginAPI(request, locale);\n${plugin}`, context);
  return {
    render: event => context.api.invokePanel('com.nora.github.panel', event),
    command: (id, args = {}) => context.api.invokeCommand(`com.nora.github.${id}`, args),
    requests, writes, links, stored: () => stored,
  };
}
const connection = { token: 'test_token' };
test('Script manifest has no native extension or signing identity', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../nora-plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.runtime, 'script');
  assert.equal(manifest.entryPoint, 'plugin.js');
  assert.equal(manifest.extensionBundleIdentifier, undefined);
  assert.equal(manifest.teamIdentifier, undefined);
});
test('Disconnected native view describes the user account and never exposes App setup', async () => {
  const f = fixture();
  const view = await f.render({});
  assert.match(texts(view), /your own account/);
  assert.ok(nodes(view).some(node => node.type === 'secureField'));
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
  assert.ok(nodes(view).find(node => node.id === 'repository').options.some(option => option.value === 'alice/project'));
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
