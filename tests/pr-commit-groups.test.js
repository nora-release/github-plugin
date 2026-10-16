import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fixture, body, repo, issue, nodes, connection, deferred } from './fixtures/plugin-fixture.js';

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');
const start = source.indexOf('function createPullRequestView('), end = source.indexOf('const panelID', start);
const createView = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
const section = (items = [], changes = {}) => ({ items, loaded: true, loading: false, error: '', nextPage: null, notice: '', ...changes });
const sha = index => index.toString(16).padStart(40, '0');
const moment = index => new Date(Date.UTC(2026, 9, 16, 0, 0, index)).toISOString();
const commit = (index, changes = {}) => ({ id: index, event: 'committed', sha: sha(index), message: `Commit title ${index}`, author: { login: `author${index}`, date: moment(index) }, ...changes });
const flatten = values => values.flatMap(value => nodes(value));
const groups = values => flatten(values).filter(value => /^pr-commit-group-[a-f\d]{16}$/.test(value.id || ''));
const groupKey = group => group.children[0].action.slice('pr-commits:'.length);
const boundedText = (value, maximum, suffix = '') => {
  if (Buffer.byteLength(String(value)) <= maximum) return String(value);
  let result = '', size = 0;
  for (const character of String(value)) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes + Buffer.byteLength(suffix) > maximum) break;
    result += character; size += bytes;
  }
  return result + suffix;
};
const view = (changes = {}) => createView({
  node: (type, properties = {}, children = []) => ({ type, ...properties, children }), t: en => en,
  boundedText, displayedBody: value => boundedText(value || 'No description.', 63 * 1024, '\nShortened.'),
  short: (value, maximum = 512) => Array.from(String(value ?? '')).slice(0, maximum).join(''),
  itemDate: item => item.updated_at || item.created_at || '', itemStatus: () => ({ text: 'Open', tone: 'success' }),
  supportsNativeLayout: true, supportsNativeTimeline: true, supportsDetailAside: true,
  avatarFor: account => `avatar:${account.login}`, ...changes,
});
const model = (timeline = []) => ({
  key: 'owner/repo/1', repo: 'owner/repo', number: 1, headSHA: sha(1000), tab: 'discussion',
  item: { number: 1, state: 'open', body: 'Original description.', user: { login: 'writer' } },
  sections: Object.fromEntries(['repository', 'comments', 'reviews', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows', 'commits', 'files'].map(name => [name, section(name === 'timeline' ? timeline : [])])),
  jobsByRun: {}, comment: { draft: 'Retained draft.', fieldID: 'draft' }, merge: { pending: null },
});

test('Three commits, a comment, and two commits become separate collapsed collections in the same conversation', () => {
  const api = view(), current = model([commit(1), commit(2), commit(3), commit(5), commit(6)]);
  current.sections.comments = section([{ id: 4, user: { login: 'commenter' }, created_at: moment(4), body: 'The separating comment.' }]);
  const content = api.nativeContent(current), conversation = content.find(value => value.id === 'pr-conversation');
  assert.deepEqual(Array.from(conversation.children, value => value.type), ['column', 'timelineItem', 'column']);
  const collections = groups(content);
  assert.deepEqual(Array.from(collections, value => value.children[0].text), ['3 commits', '2 commits']);
  assert.ok(collections.every(value => value.children.length === 1));
  assert.equal(collections[0].children[0].children[0].text, moment(3));
  assert.ok(api.toggleCommitGroup(current, groupKey(collections[0])));
  const expanded = groups(api.nativeContent(current))[0];
  assert.equal(expanded.children.length, 4);
  assert.equal(expanded.children[0].children.at(-1).symbol, 'chevron.down');
  for (let index = 1; index <= 3; index++) {
    const row = expanded.children[index];
    assert.equal(row.type, 'timelineItem'); assert.equal(row.value, 'event');
    assert.equal(row.children[0].text, `author${index}`); assert.equal(row.children[0].avatarBase64, `avatar:author${index}`);
    assert.ok(nodes(row).some(value => value.text === `Commit title ${index}`));
    assert.ok(nodes(row).some(value => value.text === moment(index)));
    assert.ok(nodes(row).some(value => value.action === `pr-open:${encodeURIComponent(`https://github.com/owner/repo/commit/${sha(index)}`)}`));
  }
  assert.ok(api.toggleCommitGroup(current, groupKey(expanded)));
  assert.equal(groups(api.nativeContent(current))[0].children.length, 1);
});

test('Reviews, non-commit events, malformed commits and a single commit remain real collection boundaries', () => {
  const api = view(), current = model([commit(1), commit(2), { id: 4, event: 'ready_for_review', actor: { login: 'writer' }, created_at: moment(4) },
    commit(5), commit(6), commit(7, { sha: 'malformed' }), commit(8), commit(10), commit(11)]);
  current.sections.reviews = section([{ id: 3, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: moment(3), body: 'Review boundary.' }]);
  current.sections.comments = section([{ id: 9, user: { login: 'writer' }, created_at: moment(9), body: 'One standalone commit precedes this.' }]);
  const conversation = api.nativeContent(current).find(value => value.id === 'pr-conversation');
  assert.deepEqual(Array.from(groups([conversation]), value => value.children[0].text), ['2 commits', '2 commits', '2 commits']);
  assert.ok(conversation.children.some(value => value.type === 'timelineItem' && nodes(value).some(child => child.text === 'Review boundary.')));
  assert.ok(conversation.children.some(value => value.type === 'timelineItem' && nodes(value).some(child => child.text === 'Commit title 8')));
  assert.ok(conversation.children.some(value => value.type === 'timelineItem' && nodes(value).some(child => child.text === 'Commit title 7')));
});

test('Duplicate SHAs are counted once, equal timestamps keep source order, and duplicate IDs do not define collection identity', () => {
  const api = view(), current = model([commit(1, { id: 77, author: { login: 'first', date: moment(1) } }),
    commit(1, { id: 78, sha: sha(1).toUpperCase(), author: { login: 'duplicate', date: moment(1) } }),
    commit(2, { id: 77, author: { login: 'second', date: moment(1) } })]);
  current.sections.comments = section([{ id: 77, user: { login: 'commenter' }, created_at: moment(1), body: 'Same-time comment.' }]);
  const conversation = api.nativeContent(current).find(value => value.id === 'pr-conversation');
  assert.ok(nodes(conversation.children[0]).some(value => value.text === 'Same-time comment.'));
  const group = groups([conversation])[0]; assert.equal(group.children[0].text, '2 commits');
  api.toggleCommitGroup(current, groupKey(group));
  const rows = groups(api.nativeContent(current))[0].children.slice(1);
  assert.deepEqual(Array.from(rows, value => value.children[0].text), ['first', 'second']);
});

test('Avatar hydration and commit title lookup keep collection identity and expansion stable', () => {
  let hydrated = false;
  const api = view({ avatarFor: account => hydrated ? `hydrated:${account.login}` : null }), current = model([commit(1), commit(2)]);
  const original = groups(api.nativeContent(current))[0], key = groupKey(original);
  api.toggleCommitGroup(current, key); hydrated = true;
  current.sections.commits = section([{ sha: sha(1), commit: { message: 'Hydrated title' }, author: { login: 'author1' } }]);
  const refreshed = groups(api.nativeContent(current))[0];
  assert.equal(refreshed.id, original.id); assert.equal(refreshed.children.length, 3);
  assert.equal(refreshed.children[1].children[0].avatarBase64, 'hydrated:author1');
  assert.ok(nodes(refreshed).some(value => value.text === 'Hydrated title'));
});

test('Pagination preserves an expanded overlapping run while unrelated groups stay collapsed and vanished identities are pruned', () => {
  const api = view(), current = model([commit(1), commit(2)]);
  current.sections.timeline.nextPage = 2;
  const original = groups(api.nativeContent(current))[0]; api.toggleCommitGroup(current, groupKey(original));
  current.sections.timeline.items.push(commit(3), commit(5), commit(6));
  current.sections.comments = section([{ id: 4, user: { login: 'writer' }, created_at: moment(4), body: 'Boundary.' }]);
  let collections = groups(api.nativeContent(current));
  assert.notEqual(collections[0].id, original.id); assert.equal(collections[0].children.length, 4); assert.equal(collections[1].children.length, 1);
  assert.ok(!api.toggleCommitGroup(current, groupKey(original)));
  current.sections.timeline.nextPage = null;
  api.nativeContent(current);
  assert.deepEqual([...current.expandedCommitGroups], [groupKey(collections[0])]);
  assert.ok(!current.commitGroupMembers.has(groupKey(original)));
  api.toggleCommitGroup(current, groupKey(collections[0]));
  assert.ok(groups(api.nativeContent(current)).every(value => value.children.length === 1));
});

test('Expanded huge collections retain a collapse header, explicit remaining count, history entry and comment composer within both budgets', () => {
  const api = view({ supportsDetailAside: false }), current = model(Array.from({ length: 200 }, (_, index) => commit(index + 1, {
    message: '😀'.repeat(160), author: { login: '😀'.repeat(80), date: moment(1) + 'x'.repeat(4096) },
  })));
  current.item.body = 'A long original description. '.repeat(4000);
  current.sections.timeline.nextPage = 2;
  const group = groups(api.nativeContent(current))[0]; assert.equal(group.children[0].text, '200 commits');
  api.toggleCommitGroup(current, groupKey(group));
  const content = api.nativeContent(current), expanded = groups(content)[0], all = flatten(content);
  assert.ok(expanded); assert.equal(expanded.children[0].action, group.children[0].action);
  assert.ok(all.some(value => /^Showing \d+ of 200 loaded commits\.$/.test(value.text || '')));
  assert.ok(all.some(value => value.action === 'pr-tab:commits' && value.text === 'View all commits'));
  assert.ok(all.some(value => value.action === 'pr-more:timeline'));
  assert.ok(all.some(value => value.type === 'textEditor' && value.value === 'Retained draft.'));
  assert.ok(all.length <= 200, `${all.length} nodes`);
  const withoutImages = (key, value) => key === 'avatarBase64' ? undefined : value;
  const bytes = Buffer.byteLength(JSON.stringify(content, withoutImages));
  assert.ok(bytes <= 185 * 1024, `${bytes} bytes`);
  assert.ok(bytes > 160 * 1024 && all.length < 190, 'Long accepted metadata must exercise the byte budget before the node limit');
  assert.ok(api.toggleCommitGroup(current, groupKey(expanded)));
  assert.equal(groups(api.nativeContent(current))[0].children.length, 1);
});

test('A loading or partial timeline cannot clear remembered expansion before authoritative history returns', () => {
  const api = view(), current = model([commit(1), commit(2)]);
  const original = groups(api.nativeContent(current))[0]; api.toggleCommitGroup(current, groupKey(original));
  current.sections.timeline = section([], { loaded: false, loading: true });
  api.nativeContent(current);
  assert.equal(current.expandedCommitGroups.size, 1);
  assert.equal(current.commitGroupMembers.size, 1);
  current.sections.timeline = section([commit(1), commit(2)], { nextPage: 2 });
  assert.equal(groups(api.nativeContent(current))[0].children.length, 3);
  current.sections.timeline.items.push(commit(3));
  const appended = groups(api.nativeContent(current))[0]; assert.equal(appended.children.length, 4);
  api.toggleCommitGroup(current, groupKey(appended));
  assert.equal(groups(api.nativeContent(current))[0].children.length, 1, 'A migrated key must remain collapsible');
  current.sections.timeline = section([]);
  api.nativeContent(current);
  assert.equal(current.expandedCommitGroups.size, 0); assert.equal(current.commitGroupMembers.size, 0);
});

test('The original Commits tab and hosts without timeline layout retain their existing content', () => {
  const current = model([commit(1), commit(2)]);
  const legacy = view({ supportsNativeTimeline: false }).nativeContent(current);
  assert.ok(!flatten(legacy).some(value => value.action?.startsWith('pr-commits:')));
  current.sections.commits = section([{ sha: sha(1), author: { login: 'first' }, commit: { message: 'Full commit tab message' } }]); current.tab = 'commits';
  const tab = view().nativeContent(current);
  assert.ok(flatten(tab).some(value => value.text === 'Full commit tab message'));
  assert.equal(groups(tab).length, 0);
});

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const author = index => ({ login: `author${index}`, avatar_url: `https://avatars.githubusercontent.com/u/${index}?v=4` });
const fullCommit = index => commit(index, { id: 77, author: { ...author(index), date: moment(index) } });
const pull = (number, head = sha(1000)) => issue(number, 'A grouped PR', { repository: { full_name: 'team/project' }, repository_url: 'https://api.github.com/repos/team/project',
  html_url: `https://github.com/team/project/pull/${number}`, pull_request: {}, user: { login: 'writer' }, head: { sha: head, ref: 'feature' }, base: { ref: 'main' }, state: 'open' });

test('Actual SDK toggle, avatar render, paginated grouping and delayed same-head refresh preserve state without GitHub writes', async () => {
  let head = sha(1000), delay = null;
  const f = fixture({ saved: connection, supportsDetailAside: true,
    ownerAvatarRoute: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, bodyBase64: image }), route: async url => {
      if (url.pathname === '/user') return body({ login: 'viewer' });
      if (url.pathname === '/user/repos') return body([repo('team/project')]);
      if (url.pathname === '/issues') return body([pull(1, head), pull(2, head)]);
      const selected = /^\/repos\/team\/project\/pulls\/([12])$/.exec(url.pathname);
      if (selected) return body(pull(Number(selected[1]), head));
      if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: false } });
      if (url.pathname.endsWith('/timeline')) {
        if (delay) { delay.started.resolve(); await delay.release.promise; }
        const page = Number(url.searchParams.get('page'));
        return page === 1 ? body([fullCommit(1), fullCommit(2)], 200, { link: '<https://api.github.com/repos/team/project/issues/1/timeline?page=2>; rel="next"' }) : body([fullCommit(2), fullCommit(3)]);
      }
      if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
      if (url.pathname.endsWith('/status')) return body({ statuses: [] });
      if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
      return body([]);
    } });
  await f.renderReady({}); await f.render({ action: 'kind:pulls' });
  let page = await f.render({ action: 'item:item-team/project/1' }), group = groups([page])[0];
  assert.equal(group.children[0].text, '2 commits', 'Repeated timeline source IDs must not erase distinct SHA records');
  const field = nodes(page).find(value => value.type === 'textEditor').id;
  page = await f.render({ action: group.children[0].action, values: { [field]: 'Draft across collection actions.' } });
  await new Promise(resolve => setImmediate(resolve)); page = await f.render({});
  assert.equal(groups([page])[0].children.length, 3);
  assert.ok(nodes(page).some(value => value.text === 'author1' && value.avatarBase64 === image));
  assert.ok(nodes(page).some(value => value.action === 'pr-more:timeline'));
  page = await f.render({ action: 'pr-more:timeline' }); group = groups([page])[0];
  assert.equal(group.children[0].text, '3 commits'); assert.equal(group.children.length, 4);
  assert.ok(!nodes(page).some(value => value.action === 'pr-more:timeline'));
  delay = { started: deferred(), release: deferred() };
  const refresh = f.render({ action: 'pr-refresh' }); await delay.started.promise;
  const loading = await f.render({});
  assert.ok(nodes(loading).some(value => value.type === 'progress' || value.id?.startsWith('pr-commit-group-')));
  delay.release.resolve(); await refresh; delay = null;
  page = await f.render({}); group = groups([page])[0];
  assert.equal(group.children[0].text, '2 commits'); assert.equal(group.children.length, 3, 'Same-head refresh keeps expansion while the timeline is incomplete');
  assert.equal(nodes(page).find(value => value.type === 'textEditor').value, 'Draft across collection actions.');
  head = sha(1001); page = await f.render({ action: 'pr-refresh' });
  assert.equal(groups([page])[0].children.length, 1, 'A new head resets expansion');
  page = await f.render({ action: groups([page])[0].children[0].action }); assert.equal(groups([page])[0].children.length, 3);
  page = await f.render({ action: 'item:item-team/project/2' }); assert.equal(groups([page])[0].children.length, 1, 'Another PR starts collapsed');
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
});
