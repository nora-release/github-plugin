import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fixture, body, searchBody, repo, issue, nodes, connection } from './fixtures/plugin-fixture.js';

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');
const start = source.indexOf('function createPullRequestView('), end = source.indexOf('const panelID', start);
const createView = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
const flatten = values => values.flatMap(value => [value, ...flatten(value.children || []), ...flatten(value.items || [])]);
const section = (items = []) => ({ items, loaded: true, loading: false, error: '', nextPage: null, notice: '' });
const when = index => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
const sha = index => index.toString(16).padStart(40, '0');
const person = login => ({ login, html_url: `https://github.com/${login}` });
const forcePush = (index, changes = {}) => ({ id: index, node_id: `force-push-${index}`, event: 'head_ref_force_pushed',
  commit_id: sha(index), actor: person(`actor-${index}`), created_at: when(index), ...changes });
const commit = index => ({ id: index, event: 'committed', sha: sha(index), message: `Original commit ${index}`,
  author: { ...person(`author-${index}`), date: when(index) } });
const view = (changes = {}) => createView({
  node: (type, properties = {}, children = []) => ({ type, ...properties, children }), t: en => en,
  boundedText: (value, maximum) => String(value).slice(0, maximum), displayedBody: value => value || 'No description.',
  short: (value, maximum = 512) => String(value ?? '').slice(0, maximum), itemDate: value => value.updated_at || value.created_at || '',
  itemStatus: () => ({ text: 'Open', tone: 'success' }), supportsNativeLayout: true, supportsNativeTimeline: true,
  supportsDetailAside: true, supportsContinuousContent: true, avatarFor: account => `avatar:${account.login}`, ...changes,
});
const model = (timeline = []) => ({
  key: 'owner/repo/1', repo: 'owner/repo', number: 1, headSHA: sha(1000), tab: 'discussion',
  item: { state: 'open', body: 'Description', user: person('author') },
  sections: Object.fromEntries(['repository', 'comments', 'reviews', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows', 'commits', 'files']
    .map(name => [name, section(name === 'timeline' ? timeline : [])])),
  comment: { draft: 'Unsent review draft', fieldID: 'draft' }, merge: { pending: null },
});
const groups = content => flatten(content).filter(value => /^pr-commit-group-[a-f\d]{16}$/.test(value.id || ''));
const header = group => group.children.find(value => value.action?.startsWith('pr-commits:'));
const key = group => header(group).action.slice('pr-commits:'.length);
const rows = group => group.children.filter(value => value.type === 'timelineItem');

test('Consecutive force pushes and ordinary commits share one collapsed collection, retaining each original event when opened', () => {
  const api = view(), events = [forcePush(1), commit(2), forcePush(3)], current = model(events);
  let content = api.nativeContent(current), collections = groups(content);
  assert.equal(collections.length, 1);
  assert.equal(header(collections[0]).text, '3 commit updates');
  assert.equal(rows(collections[0]).length, 0);
  assert.ok(api.toggleCommitGroup(current, key(collections[0])));
  content = api.nativeContent(current); collections = groups(content);
  assert.equal(collections[0].type, 'lazyColumn');
  assert.equal(rows(collections[0]).length, 3);
  for (const [index, row] of rows(collections[0]).entries()) {
    const event = events[index], author = event.actor || event.author, values = flatten([row]);
    assert.equal(row.children[0].avatarBase64, `avatar:${author.login}`);
    assert.equal(row.children[0].action, `pr-open:${encodeURIComponent(author.html_url)}`);
    assert.ok(values.some(value => value.text === (event.event === 'committed' ? event.message : 'force-pushed the source branch')));
    assert.ok(values.some(value => value.text === when(index + 1)));
    assert.ok(values.some(value => value.text === sha(index + 1).slice(0, 8)
      && value.action === `pr-open:${encodeURIComponent(`https://github.com/owner/repo/commit/${sha(index + 1)}`)}`));
  }
  assert.equal(flatten(content).find(value => value.type === 'textEditor').value, current.comment.draft);
});

test('Force-push collections have a localized update count while ordinary commits keep their existing label', () => {
  const api = view({ t: (en, zh) => zh });
  assert.equal(header(groups(api.nativeContent(model([forcePush(1), forcePush(2)])))[0]).text, '2 次提交更新');
  assert.equal(header(groups(api.nativeContent(model([commit(1), commit(2)])))[0]).text, '2 次提交');
});

test('Comments, reviews and PR title changes separate consecutive source-branch update collections', () => {
  const api = view(), current = model([forcePush(1), forcePush(2), forcePush(4), forcePush(5), forcePush(7), forcePush(8),
    { id: 9, event: 'renamed', actor: person('writer'), created_at: when(9), rename: { to: 'New title' } }, forcePush(10), forcePush(11)]);
  current.sections.comments.items = [{ id: 3, user: person('commenter'), created_at: when(3), body: 'Keep this comment between collections.' }];
  current.sections.reviews.items = [{ id: 6, user: person('reviewer'), submitted_at: when(6), state: 'APPROVED', body: 'A real review boundary.' }];
  const content = api.nativeContent(current), conversation = flatten(content).find(value => value.id === 'pr-conversation');
  assert.deepEqual(Array.from(conversation.children, value => value.id?.startsWith('pr-commit-group-') ? 'group' : 'event'),
    ['group', 'event', 'group', 'event', 'group', 'event', 'group']);
  assert.deepEqual(Array.from(groups(content), value => header(value).text), Array(4).fill('2 commit updates'));
  assert.ok(flatten(content).some(value => value.text === 'Keep this comment between collections.'));
  assert.ok(flatten(content).some(value => value.text === 'A real review boundary.'));
  assert.ok(flatten(content).some(value => value.text === 'renamed the PR to New title'));
});

test('Automatic history continuation appends to the same expanded source-branch update collection', () => {
  const api = view(), current = model([forcePush(1), commit(2), forcePush(3)]);
  current.sections.timeline.nextPage = 2;
  const initial = groups(api.nativeContent(current))[0];
  assert.ok(api.toggleCommitGroup(current, key(initial)));
  const expanded = groups(api.nativeContent(current))[0], previousIDs = rows(expanded).map(value => value.id);
  current.sections.timeline.items.push(forcePush(4), commit(5));
  current.sections.timeline.nextPage = null;
  const content = api.nativeContent(current), updated = groups(content)[0];
  assert.equal(updated.id, initial.id);
  assert.equal(updated.type, 'lazyColumn');
  assert.equal(header(updated).text, '5 commit updates');
  assert.equal(rows(updated).length, 5);
  assert.deepEqual(rows(updated).slice(0, 3).map(value => value.id), previousIDs);
  assert.ok(!flatten(content).some(value => /^pr-(?:group-page:|discussion-(?:prev|next))/.test(value.action || '')));
  assert.ok(api.toggleCommitGroup(current, key(updated)));
  assert.equal(rows(groups(api.nativeContent(current))[0]).length, 0);
});

test('Repeated force pushes to the same SHA remain distinct events and independent collections', () => {
  const api = view(), sharedSHA = sha(1), current = model([1, 2, 4, 5].map(index => forcePush(index, { commit_id: sharedSHA })));
  current.sections.comments.items = [{ id: 3, user: person('commenter'), created_at: when(3), body: 'A boundary between identical target SHAs.' }];
  const collapsed = groups(api.nativeContent(current));
  assert.equal(collapsed.length, 2);
  assert.equal(new Set(collapsed.map(value => value.id)).size, 2);
  assert.equal(new Set(collapsed.map(value => header(value).action)).size, 2);
  assert.ok(api.toggleCommitGroup(current, key(collapsed[0])));
  let expanded = groups(api.nativeContent(current));
  assert.equal(rows(expanded[0]).length, 2);
  assert.equal(rows(expanded[1]).length, 0, 'Opening one update collection must not open a later collection with the same target SHA');
  assert.ok(api.toggleCommitGroup(current, key(expanded[1])));
  expanded = groups(api.nativeContent(current));
  const eventIDs = expanded.flatMap(value => rows(value).map(row => row.id));
  assert.equal(eventIDs.length, 4);
  assert.equal(new Set(eventIDs).size, 4);
  assert.ok(api.toggleCommitGroup(current, key(expanded[0])));
  expanded = groups(api.nativeContent(current));
  assert.equal(rows(expanded[0]).length, 0);
  assert.equal(rows(expanded[1]).length, 2);
});

test('The actual SDK keeps repeated force pushes in one expanded collection as scrolling loads another API page', async () => {
  const sharedSHA = sha(1), actor = { ...person('renovate[bot]'), avatar_url: 'https://avatars.githubusercontent.com/u/10?v=4' };
  const timeline = Array.from({ length: 35 }, (_, index) => forcePush(index + 1, { commit_id: sharedSHA, actor }));
  const pull = issue(1, 'Read source-branch updates together', {
    repository: { full_name: 'team/project' }, repository_url: 'https://api.github.com/repos/team/project',
    html_url: 'https://github.com/team/project/pull/1', pull_request: {}, head: { sha: sharedSHA, ref: 'feature' }, base: { ref: 'main' },
  });
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const f = fixture({ saved: connection, supportsDetailAside: true, supportsContinuousContent: true,
    ownerAvatarRoute: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, bodyBase64: image }),
    route: async url => {
      if (url.pathname === '/user') return body({ login: 'viewer' });
      if (url.pathname === '/user/repos') return body([repo('team/project')]);
      if (url.pathname === '/search/issues') return searchBody([pull]);
      if (url.pathname === '/repos/team/project/pulls/1') return body(pull);
      if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: false } });
      if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
      if (url.pathname.endsWith('/status')) return body({ statuses: [] });
      if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
      if (url.pathname.endsWith('/timeline')) {
        const page = Number(url.searchParams.get('page') || 1);
        return body(timeline.slice((page - 1) * 30, page * 30), 200,
          page === 1 ? { link: '<https://api.github.com/repos/team/project/issues/1/timeline?page=2>; rel="next"' } : {});
      }
      return body([]);
    } });
  await f.renderReady();
  await f.render({ action: 'kind:pulls' });
  let page = await f.render({ action: 'item:item-team/project/1' });
  const initial = groups([page])[0];
  assert.ok(initial);
  assert.equal(header(initial).text, '30 commit updates');
  page = await f.render({ action: header(initial).action });
  const expanded = groups([page])[0], previousIDs = rows(expanded).map(value => value.id);
  assert.equal(rows(expanded).length, 30);
  const fieldID = nodes(page).find(value => value.type === 'textEditor').id;
  const sentinel = nodes(page).find(value => value.id === 'pr-conversation');
  assert.equal(sentinel.loadMoreAction, 'pr-discussion-load');
  page = await f.render({ action: sentinel.loadMoreAction, values: { [fieldID]: 'Keep this review local.' } });
  const updated = groups([page])[0];
  assert.equal(updated.id, initial.id);
  assert.equal(header(updated).text, '35 commit updates');
  assert.equal(rows(updated).length, 35);
  assert.equal(new Set(rows(updated).map(value => value.id)).size, 35);
  assert.deepEqual(rows(updated).slice(0, 30).map(value => value.id), previousIDs);
  assert.ok(rows(updated).every(value => value.children[0].avatarBase64 === image));
  assert.equal(nodes(page).find(value => value.type === 'textEditor').value, 'Keep this review local.');
  assert.equal(nodes(page).find(value => value.id === 'pr-conversation').loadMoreAction, undefined);
  assert.equal(f.requests.filter(value => new URL(value.url).pathname.endsWith('/timeline')).length, 2);
  assert.ok(f.requests.every(value => !value.method || value.method === 'GET'));
  assert.deepEqual(f.links, []);
  assert.deepEqual(f.drafts, []);
});
