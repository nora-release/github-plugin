import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, repo, issue, nodes, texts, connection, deferred } from './fixtures/plugin-fixture.js';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const image2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const head = 'a'.repeat(40), olderSHA = 'b'.repeat(40);
const tick = () => new Promise(resolve => setImmediate(resolve));
const avatar = (value = image, contentType = 'image/png') => ({ status: 200, headers: { 'content-type': contentType }, bodyBase64: value });
const user = (login, id) => ({ login, html_url: `https://github.com/${login}`, avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` });
const pull = (number = 1, extra = {}) => issue(number, `Pull ${number}`, { repository: { full_name: 'team/project' }, repository_url: 'https://api.github.com/repos/team/project',
  html_url: `https://github.com/team/project/pull/${number}`, pull_request: {}, user: user('writer', 10), head: { sha: head, ref: 'feature' }, base: { ref: 'main' }, ...extra });
const authors = current => nodes(current).filter(value => value.type === 'button' && (value.avatarBase64 || value.action?.startsWith('pr-open:') && value.symbol === 'person.crop.circle'));
const author = (current, login) => authors(current).find(value => value.text === login);
const avatarRequests = f => f.requests.filter(value => value.maximumResponseBytes === 8 * 1024);
function participantFixture({ pulls = [pull()], comments = [], reviews = [], reviewComments = [], timeline = [], commits = [], avatarRoute = async url => url.pathname === '/team' ? { status: 404 } : avatar(), override = () => undefined, ...options } = {}) {
  return fixture({ saved: connection, ...options, ownerAvatarRoute: avatarRoute, route: async (url, args) => {
    const response = await override(url, args);
    if (response !== undefined) return response;
    if (url.pathname === '/user') return body({ login: 'viewer' });
    if (url.pathname === '/user/repos') return body([repo('team/project')]);
    if (url.pathname === '/issues') return body(pulls);
    const selected = /^\/repos\/team\/project\/(?:issues|pulls)\/(\d+)$/.exec(url.pathname);
    if (selected) return body(pulls.find(value => value.number === Number(selected[1])));
    if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: false } });
    if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
    if (url.pathname.includes('/commits/') && url.pathname.endsWith('/status')) return body({ statuses: [] });
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
    if (/\/issues\/\d+\/comments$/.test(url.pathname)) return body(comments);
    if (/\/pulls\/\d+\/comments$/.test(url.pathname)) return body(reviewComments);
    if (url.pathname.endsWith('/reviews')) return body(reviews);
    if (url.pathname.endsWith('/timeline')) return body(timeline);
    if (url.pathname.endsWith('/commits')) return body(commits);
    return body([]);
  } });
}
async function openPR(f, number = 1) {
  await f.renderReady({}); await f.render({ action: 'kind:pulls' });
  return f.render({ action: `item:item-team/project/${number}` });
}
async function painted(f) { await tick(); return f.render({}); }

test('Issue and PR descriptions, comments, reviews, inline replies and timeline actors show their actual account images', async () => {
  const f = participantFixture({ comments: [{ id: 1, user: user('netlify[bot]', 11), body: 'Deploy preview', created_at: '2026-10-15T00:00:00Z' }],
    reviews: [{ id: 2, user: user('reviewer', 12), state: 'COMMENTED', body: 'Review message', submitted_at: '2026-10-15T00:01:00Z' }],
    reviewComments: [{ id: 3, user: user('inline', 13), body: 'Inline message', path: 'main.swift', line: 4, created_at: '2026-10-15T00:02:00Z' }],
    timeline: [{ id: 4, actor: user('actor', 14), event: 'ready_for_review', created_at: '2026-10-15T00:03:00Z' },
      { id: 5, event: 'line-commented', comments: [{ id: 6, user: user('reply', 15), body: 'Nested reply', path: 'main.swift', line: 5 }], created_at: '2026-10-15T00:04:00Z' }] });
  await openPR(f);
  const current = await painted(f);
  for (const login of ['writer', 'netlify[bot]', 'reviewer', 'inline', 'actor', 'reply']) assert.equal(author(current, login)?.avatarBase64, image, login);
  assert.ok(avatarRequests(f).every(value => value.timeoutSeconds === 3 && !value.headers.Authorization && !value.headers.Cookie));
  assert.ok(f.requests.every(value => !value.method || value.method === 'GET'));
  const issueItem = { ...pull(2), pull_request: undefined, html_url: 'https://github.com/team/project/issues/2', user: user('issue-author', 16) };
  const issues = participantFixture({ pulls: [issueItem] });
  await issues.renderReady({}); await issues.render({ action: 'item:item-team/project/2' });
  assert.equal(author(await painted(issues), 'issue-author')?.avatarBase64, image);
});

test('Case-insensitive identity reuses a repository owner image and does not download the comment author again', async () => {
  const f = participantFixture({ pulls: [pull(1, { user: user('TEAM', 40) })], comments: [{ id: 1, user: user('team', 40), body: 'Same owner', created_at: '2026-10-15T00:00:00Z' }],
    override: url => url.pathname === '/user/repos' ? body([{ ...repo('team/project'), owner: user('TeAm', 40) }]) : undefined });
  await f.renderReady({}); await tick();
  await f.render({ action: 'kind:pulls' }); await f.render({ action: 'item:item-team/project/1' });
  const current = await painted(f);
  assert.equal(author(current, 'TEAM')?.avatarBase64, image);
  assert.equal(author(current, 'team')?.avatarBase64, image);
  assert.equal(avatarRequests(f).filter(value => new URL(value.url).pathname === '/u/40').length, 1);
});

test('The signed-in avatar is reused for matching author logins regardless of case', async () => {
  const f = participantFixture({ pulls: [pull(1, { user: user('VIEWER', 50) })], override: url => {
    if (url.pathname === '/user') return body(user('viewer', 50));
    if (url.hostname === 'avatars.githubusercontent.com') return avatar();
  } });
  await openPR(f);
  assert.equal(author(await painted(f), 'VIEWER')?.avatarBase64, image);
  assert.equal(f.requests.filter(value => new URL(value.url).pathname === '/u/50').length, 1);
});

test('Two visible trusted image URLs for the same account each finish without replacing each other', async () => {
  const first = user('writer', 10), second = { ...first, login: 'WRITER', avatar_url: first.avatar_url.replace('v=4', 'v=5') };
  const f = participantFixture({ comments: [{ id: 1, user: second, body: 'A newer avatar URL' }], avatarRoute: async url => {
    if (url.pathname === '/team') return { status: 404 };
    return avatar(url.searchParams.get('v') === '5' ? image2 : image);
  } });
  await openPR(f);
  const current = await painted(f);
  assert.equal(author(current, 'writer')?.avatarBase64, image);
  assert.equal(author(current, 'WRITER')?.avatarBase64, image2);
  assert.equal(avatarRequests(f).filter(value => new URL(value.url).pathname === '/u/10').length, 2);
  await f.render({}); await tick();
  assert.equal(avatarRequests(f).filter(value => new URL(value.url).pathname === '/u/10').length, 2);
});

test('Delayed participant images never block readable details and notify Nora when they finish', async () => {
  const started = deferred(), release = deferred();
  const f = participantFixture({ avatarRoute: async url => {
    if (url.pathname === '/u/10') { started.resolve(); await release.promise; return avatar(); }
    return { status: 404 };
  } });
  try {
    const current = await openPR(f); await started.promise;
    assert.ok(nodes(current).some(value => value.type === 'markdown' && value.text === 'Description'));
    assert.equal(author(current, 'writer')?.symbol, 'person.crop.circle');
    const before = f.invalidations.length;
    release.resolve(); await tick();
    assert.ok(f.invalidations.length > before);
    assert.equal(author(await f.render({}), 'writer')?.avatarBase64, image);
  } finally { release.resolve(); }
});

test('Invalid avatar URLs use only the safe account fallback and failed images retry only on an explicit refresh', async () => {
  let fails = true;
  const f = participantFixture({ pulls: [pull(1, { user: { login: 'writer', avatar_url: 'https://evil.test/private-image' } })], avatarRoute: async url => {
    assert.equal(url.hostname, 'avatars.githubusercontent.com');
    if (url.pathname === '/writer') return fails ? { status: 404 } : avatar();
    return { status: 404 };
  } });
  await openPR(f); await tick();
  for (let index = 0; index < 4; index++) await f.render({});
  assert.equal(avatarRequests(f).filter(value => new URL(value.url).pathname === '/writer').length, 1);
  assert.ok(!f.requests.some(value => new URL(value.url).hostname === 'evil.test'));
  fails = false;
  await f.render({ action: 'refresh-detail' });
  assert.equal(author(await painted(f), 'writer')?.avatarBase64, image);
  assert.equal(avatarRequests(f).filter(value => new URL(value.url).pathname === '/writer').length, 2);
});

test('Owner and participant downloads together stay within four requests', async () => {
  const release = deferred(); let active = 0, maximum = 0;
  const f = participantFixture({ comments: Array.from({ length: 12 }, (_, index) => ({ id: index, user: user(`person-${index}`, 60 + index), body: `Comment ${index}` })),
    avatarRoute: async () => { active++; maximum = Math.max(maximum, active); await release.promise; active--; return avatar(); } });
  try {
    await openPR(f); await tick();
    assert.equal(maximum, 4);
    release.resolve(); await tick();
    assert.ok(author(await f.render({}), 'writer')?.avatarBase64);
    assert.equal(maximum, 4);
  } finally { release.resolve(); }
});

test('Page changes retain valid images in cache without repainting a different visible author', async () => {
  const started = deferred(), release = deferred();
  const f = participantFixture({ pulls: [pull(), pull(2, { user: user('other', 20) })], avatarRoute: async url => {
    if (url.pathname === '/u/10') { started.resolve(); await release.promise; return avatar(); }
    return url.pathname === '/u/20' ? avatar(image2) : { status: 404 };
  } });
  try {
    await openPR(f); await started.promise;
    await f.render({ action: 'item:item-team/project/2' }); await tick();
    const before = f.invalidations.length;
    release.resolve(); await tick();
    assert.equal(f.invalidations.length, before, 'An off-page writer cannot cause an unrelated redraw');
    assert.equal(author(await f.render({}), 'other')?.avatarBase64, image2);
    const back = await f.render({ action: 'item:item-team/project/1' });
    assert.equal(author(back, 'writer')?.avatarBase64, image);
    assert.equal(avatarRequests(f).filter(value => new URL(value.url).pathname === '/u/10').length, 1);
  } finally { release.resolve(); }
});

test('A pending shared author image still reaches the replacement page that displays the same account', async () => {
  const started = deferred(), release = deferred();
  const f = participantFixture({ pulls: [pull(), pull(2)], avatarRoute: async url => {
    if (url.pathname !== '/u/10') return { status: 404 };
    started.resolve(); await release.promise; return avatar();
  } });
  try {
    await openPR(f); await started.promise;
    await f.render({ action: 'item:item-team/project/2' });
    const before = f.invalidations.length;
    release.resolve(); await tick();
    assert.ok(f.invalidations.length > before);
    assert.equal(author(await f.render({}), 'writer')?.avatarBase64, image);
    assert.equal(avatarRequests(f).filter(value => new URL(value.url).pathname === '/u/10').length, 1);
  } finally { release.resolve(); }
});

test('An old account participant response cannot populate or notify after disconnect', async () => {
  const started = deferred(), release = deferred();
  const f = participantFixture({ avatarRoute: async url => {
    if (url.pathname !== '/u/10') return { status: 404 };
    started.resolve(); await release.promise; return avatar();
  } });
  try {
    await openPR(f); await started.promise;
    await f.render({ action: 'disconnect' });
    const before = f.invalidations.length;
    release.resolve(); await tick();
    assert.equal(f.invalidations.length, before);
    assert.ok(nodes(await f.render({})).every(value => !value.avatarBase64));
  } finally { release.resolve(); }
});

test('Timeline commit authors use exact GitHub commit identity and keep unmatched git names as names', async () => {
  const commits = [{ sha: head, author: user('linked-author', 90), commit: { message: 'Linked message', author: { name: 'Git Name' } } },
    { sha: olderSHA, author: null, committer: user('wrong-committer', 91), commit: { message: 'Unknown message', author: { name: 'team', email: 'not-a-github-login@example.com' } } }];
  const f = participantFixture({ timeline: [{ id: 1, event: 'committed', sha: head.toUpperCase(), author: { name: 'Raw Git Name' } },
    { id: 2, event: 'committed', sha: olderSHA, author: { name: 'team' }, actor: user('wrong-pusher', 94) }], commits });
  const collapsed = await openPR(f);
  const group = nodes(collapsed).find(value => value.action?.startsWith('pr-commits:'));
  assert.ok(group);
  assert.ok(!author(collapsed, 'Raw Git Name'));
  const initial = await f.render({ action: group.action });
  assert.ok(author(initial, 'Raw Git Name'));
  let current = await painted(f); current = await painted(f);
  assert.equal(author(current, 'linked-author')?.avatarBase64, image);
  assert.equal(author(current, 'team')?.symbol, 'person.crop.circle');
  assert.ok(!avatarRequests(f).some(value => new URL(value.url).pathname === '/u/91'));
  assert.ok(!avatarRequests(f).some(value => new URL(value.url).pathname === '/u/94'));
  current = await f.render({ action: 'pr-tab:commits' }); current = await painted(f);
  assert.equal(author(current, 'linked-author')?.avatarBase64, image);
  assert.equal(author(current, 'team')?.symbol, 'person.crop.circle');
});

test('Visible commit SHA matching continues onto the next page and stops once matched', async () => {
  const first = Array.from({ length: 30 }, (_, index) => ({ sha: index.toString(16).padStart(40, '0'), author: user('unrelated', 92), commit: { message: 'Older' } }));
  const f = participantFixture({ timeline: [{ id: 1, event: 'committed', sha: head, author: { name: 'Raw Git Name' } }], override: url => {
    if (!url.pathname.endsWith('/commits')) return;
    const page = Number(url.searchParams.get('page'));
    return page === 1 ? body(first, 200, { link: '<https://api.github.com/repos/team/project/pulls/1/commits?page=2>; rel="next"' })
      : body([{ sha: head, author: user('linked-author', 93), commit: { message: 'Match' } }], 200, { link: '<https://api.github.com/repos/team/project/pulls/1/commits?page=3>; rel="next"' });
  } });
  await openPR(f);
  for (let index = 0; index < 4; index++) await painted(f);
  assert.equal(author(await f.render({}), 'linked-author')?.avatarBase64, image);
  assert.deepEqual(f.requests.filter(value => new URL(value.url).pathname.endsWith('/commits')).map(value => new URL(value.url).searchParams.get('page')), ['1', '2']);
  assert.ok(!avatarRequests(f).some(value => new URL(value.url).pathname === '/u/92'), 'Unrendered commit authors do not need an image');
});

test('Leaving the discussion stops further optional commit pages', async () => {
  const started = deferred(), release = deferred();
  const f = participantFixture({ timeline: [{ id: 1, event: 'committed', sha: head, author: { name: 'Raw Git Name' } }], override: async url => {
    if (!url.pathname.endsWith('/commits')) return undefined;
    started.resolve(); await release.promise;
    return body([], 200, { link: '<https://api.github.com/repos/team/project/pulls/1/commits?page=2>; rel="next"' });
  } });
  try {
    await openPR(f); await started.promise;
    await f.render({ action: 'pr-tab:files' });
    release.resolve(); await tick(); await f.render({}); await tick();
    assert.equal(f.requests.filter(value => new URL(value.url).pathname.endsWith('/commits')).length, 1);
  } finally { release.resolve(); }
});

test('Large optional images preserve the same fitted comments and actions within the native byte budget', async () => {
  const release = deferred(), largeImage = Buffer.alloc(8 * 1024, 255).toString('base64');
  const comments = Array.from({ length: 28 }, (_, index) => ({ id: index + 1, user: user(`person-${index}`, 100 + index), body: `Comment ${index} ` + 'Full text. '.repeat(650), created_at: `2026-10-15T00:${String(index).padStart(2, '0')}:00Z` }));
  const f = participantFixture({ comments, avatarRoute: async url => {
    if (url.pathname === '/team') return { status: 404 };
    await release.promise; return avatar(largeImage);
  } });
  try {
    const before = await openPR(f);
    const content = value => nodes(value).filter(entry => entry.type === 'markdown').map(entry => entry.text);
    const actions = value => nodes(value).filter(entry => entry.action).map(entry => [entry.action, entry.id]);
    release.resolve(); await tick();
    const after = await f.render({});
    assert.deepEqual(content(after), content(before));
    assert.deepEqual(actions(after), actions(before));
    const normalize = value => ({ ...value, options: value.options || [], disabled: value.disabled || false,
      children: (value.children || []).map(normalize), items: (value.items || []).map(normalize) });
    assert.ok(Buffer.byteLength(JSON.stringify(normalize(after)).replace(/\//g, '\\/')) <= 400 * 1024);
    assert.ok(authors(after).some(value => value.avatarBase64));
    assert.ok(authors(after).some(value => !value.avatarBase64 && value.symbol === 'person.crop.circle'));
    assert.ok(nodes(after).some(value => value.action === 'pr-comment'));
  } finally { release.resolve(); }
});
