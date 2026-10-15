import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, issue, nodes, texts, connection, deferred } from './fixtures/plugin-fixture.js';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const avatar = () => ({ status: 200, headers: { 'content-type': 'image/png' }, bodyBase64: image });
const tick = () => new Promise(resolve => setImmediate(resolve));
const feedItem = (owner, number) => issue(number, `Work ${number}`, { repository: { full_name: `${owner}/project` },
  repository_url: `https://api.github.com/repos/${owner}/project`, html_url: `https://github.com/${owner}/project/issues/${number}` });

test('The initial panel returns progress before unresolved credentials and reuses one restore', async () => {
  const started = deferred(), release = deferred();
  let reads = 0, returned = false;
  const f = fixture({ saved: connection, beforeRead: async () => {
    reads++;
    if (reads === 1) { started.resolve(); await release.promise; }
  } });
  const rendering = f.render({}).then(value => { returned = true; return value; });
  try {
    await started.promise; await tick();
    assert.equal(returned, true, 'Rendering progress cannot await the credential request');
    assert.equal((await rendering).id, 'github-restoring');
    assert.equal((await f.render({})).id, 'github-restoring');
    assert.equal(reads, 1);
    assert.equal(f.requests.length, 0);
  } finally { release.resolve(); }
  const ready = await f.renderReady({});
  assert.equal(ready.type, 'workspace');
  assert.ok(f.invalidations.some(value => value.panelID === 'com.nora.github.panel'));
  assert.ok(f.invalidations.every(value => Object.keys(value).length === 1), 'Background refresh cannot carry an action capability');
});

test('Expired-token renewal and account loading run after the progress response', async () => {
  const started = deferred(), release = deferred();
  const saved = { token: 'old_token', expiresAt: 1, refreshToken: 'refresh_token', refreshExpiresAt: 9_000_000 };
  let returned = false;
  const f = fixture({ saved, now: () => 1_000_000, route: async (url, args) => {
    if (url.pathname === '/login/oauth/access_token') { started.resolve(); await release.promise; return body({ access_token: 'new_token', token_type: 'bearer', expires_in: 28800 }); }
    assert.equal(args.headers.Authorization, 'Bearer new_token');
    if (url.pathname === '/user') return body({ login: 'alice' });
    return body([]);
  } });
  const rendering = f.render({}).then(value => { returned = true; return value; });
  try {
    await started.promise; await tick();
    assert.equal(returned, true, 'A token refresh cannot consume the panel render deadline');
    assert.equal((await rendering).id, 'github-restoring');
    assert.equal(f.requests.filter(value => new URL(value.url).hostname === 'api.github.com').length, 0);
  } finally { release.resolve(); }
  assert.equal((await f.renderReady({})).type, 'workspace');
  assert.equal(JSON.parse(f.stored()).token, 'new_token');
});

test('An unresolved user request does not delay progress and a disconnect drops its result and refresh', async () => {
  const started = deferred(), release = deferred();
  let returned = false;
  const f = fixture({ saved: connection, route: async url => {
    assert.equal(url.pathname, '/user', 'A cancelled restore cannot fetch repository data');
    started.resolve(); await release.promise; return body({ login: 'old-account' });
  } });
  const rendering = f.render({}).then(value => { returned = true; return value; });
  try {
    await started.promise; await tick();
    assert.equal(returned, true);
    assert.equal((await rendering).id, 'github-restoring');
    const disconnected = await f.render({ action: 'disconnect' });
    assert.ok(nodes(disconnected).some(value => value.action === 'begin-login'));
  } finally { release.resolve(); }
  await tick();
  assert.equal(f.invalidations.length, 0, 'The cancelled generation must not request a redraw');
  assert.doesNotMatch(texts(await f.render({})), /old-account/);
  assert.equal(f.stored(), null);
});

test('Readable items and filters return while account and owner avatars remain unresolved', async () => {
  const accountRelease = deferred(), ownersRelease = deferred(), ownersStarted = deferred();
  let active = 0, maximum = 0;
  const f = fixture({ saved: connection, ownerAvatarRoute: async () => {
    active++; maximum = Math.max(maximum, active);
    if (active === 4) ownersStarted.resolve();
    await ownersRelease.promise; active--; return avatar();
  }, route: async url => {
    if (url.hostname === 'avatars.githubusercontent.com') { await accountRelease.promise; return avatar(); }
    if (url.pathname === '/user') return body({ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
    if (url.pathname === '/user/repos') return body([]);
    return body([feedItem('alice', 1), ...Array.from({ length: 8 }, (_, index) => feedItem(`team-${index}`, index + 2))]);
  } });
  try {
    const initial = await f.renderReady({});
    assert.equal(initial.children[0].items.length, 9);
    assert.equal(initial.children[0].children[0].avatarBase64, undefined);
    assert.ok(initial.children[0].items.every(value => !value.avatarBase64));
    await ownersStarted.promise;
    const filtered = await f.render({ action: 'query', value: 'team' });
    assert.equal(filtered.children[0].items.length, 8);
    assert.equal(maximum, 4);
    const before = f.invalidations.length;
    accountRelease.resolve(); await tick();
    assert.ok(f.invalidations.length > before, 'The account image asks Nora to refresh after it arrives');
    const account = await f.render({ action: 'clear-filters' });
    assert.equal(account.children[0].children[0].avatarBase64, image);
    assert.equal(account.children[0].items[0].avatarBase64, image, 'The account owner row receives the completed account image');
  } finally { accountRelease.resolve(); ownersRelease.resolve(); }
  await tick();
  const completed = await f.render({});
  assert.ok(completed.children[0].items.every(value => value.avatarBase64 === image));
  assert.equal(maximum, 4);
  assert.ok(f.requests.filter(value => value.responseEncoding === 'base64').every(value => !value.headers.Authorization && !value.headers.Cookie));
});

test('Old avatar responses cannot repaint or populate a replacement account', async () => {
  const accountStarted = deferred(), accountRelease = deferred(), ownerStarted = deferred(), ownerRelease = deferred();
  const f = fixture({ saved: connection, ownerAvatarRoute: async () => { ownerStarted.resolve(); await ownerRelease.promise; return avatar(); },
    route: async (url, args) => {
      if (url.hostname === 'avatars.githubusercontent.com') { accountStarted.resolve(); await accountRelease.promise; return avatar(); }
      const newer = args.headers.Authorization === 'Bearer newer_token';
      if (url.pathname === '/user') return body(newer ? { login: 'bob' } : { login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
      if (url.pathname === '/user/repos') return body([]);
      return body(newer ? [] : [feedItem('old-team', 1)]);
    } });
  try {
    await f.renderReady({}); await accountStarted.promise; await ownerStarted.promise;
    const next = await f.render({ action: 'connect-token', values: { token: 'newer_token' } });
    assert.equal(next.children[0].children[0].text, 'bob');
    await tick();
    const before = f.invalidations.length;
    accountRelease.resolve(); ownerRelease.resolve(); await tick();
    assert.equal(f.invalidations.length, before, 'Old downloads must not notify for the new account');
    const latest = await f.render({});
    assert.equal(latest.children[0].items.length, 0);
    assert.ok(nodes(latest).every(value => !value.avatarBase64));
    assert.equal(JSON.parse(f.stored()).token, 'newer_token');
  } finally { accountRelease.resolve(); ownerRelease.resolve(); }
});

test('Failed background restoration keeps the error and saved credentials until an explicit retry', async () => {
  let fails = true;
  const f = fixture({ saved: connection, route: async url => {
    if (url.pathname === '/user') return fails ? body({}, 503) : body({ login: 'alice' });
    return body([]);
  } });
  const failed = await f.renderReady({});
  assert.match(texts(failed), /could not be reached/);
  assert.match(texts(await f.render({})), /could not be reached/, 'A passive redraw must preserve the recovery error');
  assert.equal(f.stored(), connection);
  assert.equal(f.writes.length, 0);
  fails = false;
  assert.equal((await f.render({ action: 'retry-load' })).id, 'github-restoring');
  assert.equal((await f.renderReady({})).type, 'workspace');
  assert.equal(f.stored(), connection);
});

test('Earlier hosts retain synchronous restoration without waiting for optional avatars', async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ saved: connection, supportsPanelInvalidation: false, route: async url => {
    if (url.hostname === 'avatars.githubusercontent.com') { started.resolve(); await release.promise; return avatar(); }
    if (url.pathname === '/user') return body({ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
    if (url.pathname === '/user/repos') return body([]);
    return body([feedItem('alice', 1)]);
  } });
  try {
    const initial = await f.render({}); await started.promise;
    assert.equal(initial.type, 'workspace');
    assert.equal(initial.children[0].items.length, 1);
    assert.equal(initial.children[0].children[0].avatarBase64, undefined);
  } finally { release.resolve(); }
  await tick();
  assert.equal((await f.render({})).children[0].children[0].avatarBase64, image);
  assert.equal(f.invalidations.length, 0);
});

test('Avatar refreshes merge while a host invalidation is pending and flush the latest image state', async () => {
  const notifyStarted = deferred(), notifyRelease = deferred(), imagesRelease = deferred();
  let notificationsInFlight = 0, maximum = 0;
  const f = fixture({ saved: connection, onInvalidate: async () => {
    notificationsInFlight++; maximum = Math.max(maximum, notificationsInFlight); notifyStarted.resolve();
    await notifyRelease.promise; notificationsInFlight--; return true;
  }, ownerAvatarRoute: async () => { await imagesRelease.promise; return avatar(); }, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([]);
    return body(Array.from({ length: 8 }, (_, index) => feedItem(`team-${index}`, index + 1)));
  } });
  try {
    await f.renderReady({}); await notifyStarted.promise;
    imagesRelease.resolve(); await tick();
    assert.equal(f.invalidations.length, 1, 'The image batch cannot flood a host notification already in flight');
    notifyRelease.resolve(); await tick();
    assert.equal(f.invalidations.length, 2, 'One follow-up invalidation contains the latest completed image batch');
    assert.equal(maximum, 1);
    assert.ok((await f.render({})).children[0].items.every(value => value.avatarBase64 === image));
  } finally { imagesRelease.resolve(); notifyRelease.resolve(); }
});

test('A rejected invalidation cannot turn optional image loading into an account error', async () => {
  const f = fixture({ saved: connection, onInvalidate: async () => { throw new Error('Unsupported notification'); }, ownerAvatarRoute: async () => avatar(), route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([]);
    return body([feedItem('team', 1)]);
  } });
  const ready = await f.renderReady({});
  assert.equal(ready.type, 'workspace');
  await tick();
  const refreshed = await f.render({});
  assert.equal(refreshed.children[0].items[0].avatarBase64, image);
  assert.doesNotMatch(texts(refreshed), /Unsupported notification|could not be reached/);
});
