import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');
const start = source.indexOf('function createPullRequestView('), end = source.indexOf('const panelID', start);
const createView = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
const headSHA = 'a'.repeat(40);
const section = (items = [], changes = {}) => ({ items, loaded: true, loading: false, error: '', notice: '', nextPage: null, ...changes });
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || []), ...flatten(node.items || [])]);
const text = nodes => flatten(nodes).map(node => node.text || '').join('\n');
const account = login => ({ login, html_url: `https://github.com/${login}`, avatar_url: `https://avatars.githubusercontent.com/${login}` });
const view = (changes = {}) => createView({
  node: (type, properties = {}, children = []) => ({ type, ...properties, children }), t: en => en,
  boundedText: (value, maximum, suffix = '') => Buffer.byteLength(String(value)) <= maximum ? String(value) : String(value).slice(0, maximum - suffix.length) + suffix,
  displayedBody: value => value || 'No description.', short: (value, maximum = 512) => String(value ?? '').slice(0, maximum),
  itemDate: item => String(item.updated_at || item.created_at || '').slice(0, 10), itemStatus: () => ({ text: 'Open', tone: 'success' }),
  supportsNativeLayout: true, supportsNativeTimeline: true, supportsDetailAside: true, avatarFor: user => `avatar:${user.login}`,
  ...changes,
});
const model = () => ({
  key: 'owner/repo/1', repo: 'owner/repo', number: 1, headSHA, tab: 'discussion',
  item: { number: 1, state: 'open', title: 'A real change', body: 'The full original description.', user: account('author'), created_at: '2026-10-15T00:00:00Z',
    base: { ref: 'main' }, head: { ref: 'feature', sha: headSHA }, changed_files: 60, additions: 2348, deletions: 882,
    comments: 2, review_comments: 3, requested_reviewers: [account('requested')], mergeable: false, mergeable_state: 'dirty' },
  sections: Object.fromEntries(['repository', 'comments', 'reviews', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows', 'commits', 'files'].map(name => [name, section()])),
  jobsByRun: {}, comment: { draft: 'An unfinished reply.', fieldID: 'draft' }, merge: { pending: null },
});

test('The context column contains only the five metadata sections and no duplicate comment check or merge summary', () => {
  const api = view(), current = model(), aside = api.nativeAside(current);
  assert.equal(aside.length, 1);
  assert.equal(aside[0].type, 'column');
  assert.equal(aside[0].id, 'pr-context-aside');
  assert.deepEqual(Array.from(aside[0].children.filter(node => node.type === 'column'), node => node.id),
    ['pr-aside-reviewers', 'pr-aside-assignees', 'pr-aside-labels', 'pr-aside-milestone', 'pr-aside-changes']);
  assert.equal(aside[0].children.filter(node => node.type === 'divider').length, 4);
  assert.equal(aside[0].children.at(-1).id, 'pr-aside-changes');
  const nodes = flatten(aside);
  assert.ok(nodes.some(node => node.text === '60 files' && node.action === 'pr-tab:files'));
  assert.ok(nodes.some(node => node.text === '+2348' && node.tone === 'success'));
  assert.ok(nodes.some(node => node.text === '−882' && node.tone === 'danger'));
  assert.ok(!nodes.some(node => ['pr-aside-comments', 'pr-aside-checks', 'pr-aside-merge'].includes(node.id)));
  assert.ok(!nodes.some(node => /^(?:pr-toggle-merge|pr-merge:|pr-confirm-merge|pr-comment$|pr-tab:(?:checks|discussion)$)/.test(node.action || '')));
});

test('Reviewers preserve participant avatar tracking and distinguish requested, approved and changes requested states', () => {
  const current = model(), tracked = new WeakMap(), api = view({ onAuthorButton: (node, user) => tracked.set(node, user) });
  current.sections.reviews = section([
    { id: 1, user: account('approved'), state: 'APPROVED', submitted_at: '2026-10-14T00:00:00Z' },
    { id: 2, user: account('approved'), state: 'COMMENTED', submitted_at: '2026-10-15T00:00:00Z' },
    { id: 3, user: account('changes'), state: 'CHANGES_REQUESTED', submitted_at: '2026-10-14T00:00:00Z' },
    { id: 4, user: account('requested'), state: 'APPROVED', submitted_at: '2026-10-14T00:00:00Z' },
  ]);
  const reviewerSection = api.nativeAside(current)[0].children.find(node => node.id === 'pr-aside-reviewers');
  const rows = reviewerSection.children.filter(node => node.type === 'row');
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const author = row.children[0];
    assert.equal(author.avatarBase64, `avatar:${author.text}`);
    assert.equal(tracked.get(author).login, author.text);
  }
  assert.equal(rows.find(row => row.children[0].text === 'approved').children.at(-1).text, 'Approved', 'A later comment does not erase an approval');
  assert.equal(rows.find(row => row.children[0].text === 'changes').children.at(-1).text, 'Changes requested');
  assert.equal(rows.find(row => row.children[0].text === 'requested').children.at(-1).text, 'Requested', 'An outstanding new review request takes precedence over an old approval');
});

test('Assignees labels and milestone use real bounded metadata and only expose read-only links', () => {
  const current = model(), tracked = new WeakMap(), api = view({ onAuthorButton: (node, user) => tracked.set(node, user) });
  current.item.assignees = [account('same'), account('SAME'), ...Array.from({ length: 9 }, (_, index) => account(`assigned${index}`))];
  current.item.labels = ['bug', { name: 'bug' }, ...Array.from({ length: 10 }, (_, index) => ({ name: `label${index}-` + 'long'.repeat(50) }))];
  current.item.milestone = { title: 'Ship native cards', html_url: 'https://github.com/owner/repo/milestone/3' };
  const aside = api.nativeAside(current)[0];
  const assignees = aside.children.find(node => node.id === 'pr-aside-assignees');
  const people = assignees.children.filter(node => node.type === 'button' && node.avatarBase64);
  assert.equal(people.length, 6);
  assert.equal(people.filter(node => node.text.toLowerCase() === 'same').length, 1);
  for (const person of people) assert.equal(person.avatarBase64, `avatar:${tracked.get(person).login}`);
  assert.ok(assignees.children.some(node => node.text === 'View all assignees' && node.action.startsWith('pr-open:')));
  const labels = aside.children.find(node => node.id === 'pr-aside-labels');
  assert.equal(labels.children.filter(node => node.type === 'badge').length, 8);
  assert.ok(labels.children.filter(node => node.type === 'badge').every(node => node.text.length <= 128));
  assert.equal(labels.children.filter(node => node.text === 'bug').length, 1);
  assert.ok(labels.children.some(node => node.text === 'View all labels'));
  const milestone = aside.children.find(node => node.id === 'pr-aside-milestone').children.find(node => node.type === 'button');
  assert.equal(milestone.text, 'Ship native cards');
  assert.equal(decodeURIComponent(milestone.action.slice('pr-open:'.length)), current.item.milestone.html_url);
  current.item.milestone.html_url = 'https://evil.test/stolen';
  assert.ok(!flatten(api.nativeAside(current)).some(node => node.action?.includes('evil.test')));
  assert.ok(flatten([aside]).filter(node => node.type === 'button').every(node => node.action.startsWith('pr-open:') || node.action.startsWith('pr-tab:')));
});

test('Metadata distinguishes known empty values from missing or malformed GitHub fields', () => {
  for (const [metadata, expected] of [
    [{ assignees: [], labels: [], milestone: null }, ['No assignees', 'No labels', 'No milestone']],
    [{}, ['Assignees not available', 'Labels not available', 'Milestone not available']],
    [{ assignees: [{}], assignee: null, labels: [{}], milestone: {} }, ['Assignees not available', 'Labels not available', 'Milestone not available']],
  ]) {
    const current = model(); Object.assign(current.item, metadata);
    const aside = text(view().nativeAside(current));
    for (const value of expected) assert.ok(aside.includes(value), value);
  }
  const current = model(); current.item.assignee = account('legacy-assignee');
  assert.ok(flatten(view().nativeAside(current)).some(node => node.text === 'legacy-assignee' && node.avatarBase64 === 'avatar:legacy-assignee'));
});

test('Unavailable and paginated review data remain visibly incomplete with bounded reviewer rows', () => {
  for (const changes of [{ loaded: false, error: 'Permission denied' }, { loading: true }, { nextPage: 2 }, { notice: 'Source capped' }]) {
    const current = model(); current.item.requested_reviewers = [];
    current.sections.reviews = section(Array.from({ length: 9 }, (_, index) => ({ id: index, user: account(`reviewer${index}`), state: 'APPROVED' })), changes);
    const aside = apiAside(current);
    assert.match(text(aside), /Review information is incomplete/);
    assert.equal(flatten(aside).filter(node => node.avatarBase64).length, 6);
    assert.ok(flatten(aside).some(node => node.text === 'View all reviewers' && node.action.startsWith('pr-open:')));
  }
  function apiAside(current) { return view().nativeAside(current); }
});

test('Loaded or incomplete comments and checks never restore removed context sections', () => {
  const current = model();
  const api = view(), expected = api.nativeAside(current);
  for (const source of ['comments', 'reviewComments', 'checks', 'statuses', 'workflows']) {
    current.sections[source] = section([{ id: 1, name: 'real-check', context: 'real-status', head_sha: headSHA, status: 'completed', conclusion: 'failure' }]);
  }
  assert.deepEqual(api.nativeAside(current), expected);
  for (const source of ['comments', 'reviewComments', 'checks', 'statuses', 'workflows']) {
    current.sections[source] = section([], { loaded: false, loading: true, error: 'Unavailable', nextPage: 2, notice: 'Source capped' });
  }
  delete current.item.comments; delete current.item.review_comments;
  current.item.merged = true; current.item.state = 'closed';
  assert.deepEqual(api.nativeAside(current), expected);
});

test('Merge access stays in the modern toolbar only for an open writable repository', () => {
  const current = model(), api = view();
  current.sections.repository = section([], { data: { permissions: { push: true } } });
  for (const tab of ['discussion', 'checks', 'commits', 'files']) {
    current.tab = tab;
    const actions = api.nativeToolbarActions(current);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'pr-toggle-merge');
    assert.equal(actions[0].disabled, false);
  }
  current.merge.busy = true;
  assert.equal(api.nativeToolbarActions(current)[0].disabled, true);
  current.merge.busy = false;
  for (const changes of [{ state: 'closed' }, { state: undefined }, { draft: true }, { merged: true }, { merged_at: '2026-10-16' }, { pull_request: { merged_at: '2026-10-16' } }]) {
    const original = current.item; current.item = { ...original, ...changes };
    assert.equal(api.nativeToolbarActions(current).length, 0);
    current.item = original;
  }
  for (const changes of [{ loaded: false }, { loading: true }, { error: 'Permission denied' }, { data: { archived: true, permissions: { push: true } } }, { data: { permissions: { push: false } } }, { data: {} }]) {
    const original = current.sections.repository; current.sections.repository = { ...original, ...changes };
    assert.equal(api.nativeToolbarActions(current).length, 0);
    current.sections.repository = original;
  }
  for (const changes of [{ supportsDetailAside: false }, { supportsNativeLayout: false }, { supportsNativeTimeline: false }]) {
    assert.equal(view(changes).nativeToolbarActions(current).length, 0);
  }
});

test('Missing reviewer sources remain distinct from known empty reviews', () => {
  const current = model(); current.item.requested_reviewers = [];
  current.sections.reviews = section([], { loaded: false, loading: true });
  const pending = text(view().nativeAside(current));
  assert.match(pending, /Reviewers not available yet/);
  assert.doesNotMatch(pending, /all checks passed|all.*approved|ready to merge/i);
  current.sections.reviews = section();
  const empty = text(view().nativeAside(current));
  assert.match(empty, /No reviewers/);
});

test('The original description is a comment card with its real author date and association before activity', () => {
  const api = view(), current = model();
  current.item.author_association = 'MEMBER'; current.item.labels = [{ name: 'bug' }];
  const body = api.nativeContent(current), description = body.find(node => node.id === 'pr-description');
  assert.equal(description.type, 'timelineItem'); assert.equal(description.value, 'comment');
  assert.deepEqual(Array.from(description.children, node => node.type), ['button', 'row', 'column']);
  assert.equal(description.children[0].text, 'author');
  assert.equal(description.children[0].avatarBase64, 'avatar:author');
  assert.match(text([description.children[1]]), /opened 2026-10-15/);
  assert.ok(flatten([description.children[1]]).some(node => node.type === 'badge' && node.text === 'Member'));
  assert.deepEqual(Array.from(description.children[2].children, node => node.type), ['markdown']);
  assert.equal(description.children[2].children[0].text, current.item.body);
  assert.ok(flatten(api.nativeAside(current)).some(node => node.type === 'badge' && node.text === 'bug'));
  assert.equal(body[0].id, 'pr-description');
  assert.equal(body[1].id, 'pr-conversation');
  assert.ok(!body.some(node => node.type === 'divider' || node.text === 'Activity'));
  assert.ok(!flatten(body).some(node => node.id === 'pr-readiness'), 'Modern discussion avoids duplicate readiness summaries');
  assert.equal(body.at(-1).id, 'pr-comment-composer');
  assert.ok(flatten(body).some(node => node.type === 'textEditor' && node.value === 'An unfinished reply.'));
});

test('Issues use the same original comment card and absent or unknown associations are never invented', () => {
  const api = view(), current = model();
  const issue = { item: current.item, repo: current.repo, number: current.number };
  const description = api.nativeDescription(issue, 'https://github.com/owner/repo/issues/1', 'issue-description');
  assert.equal(description.type, 'timelineItem'); assert.equal(description.value, 'comment');
  assert.equal(description.id, 'issue-description');
  assert.equal(description.children[0].text, 'author');
  assert.equal(description.children[2].children[0].text, current.item.body);
  for (const value of [undefined, '', 'NONE', 'UNKNOWN', 'constructor', '__proto__']) {
    current.item.author_association = value;
    const description = api.nativeDescription(current);
    assert.ok(!flatten([description.children[1]]).some(node => node.type === 'badge'));
    assert.ok(flatten([description.children[2]]).some(node => node.type === 'markdown' && node.text === current.item.body));
  }
});

test('Every loaded discussion page stays reachable inside Nora with its context and draft inside both budgets', () => {
  const current = model(), api = view();
  current.item.assignees = Array.from({ length: 12 }, (_, index) => account(`assignee${index}`));
  current.item.labels = Array.from({ length: 16 }, (_, index) => ({ name: `label${index}-` + 'long name '.repeat(30) }));
  current.item.milestone = { title: 'A real milestone', html_url: 'https://github.com/owner/repo/milestone/1' };
  current.sections.comments = section(Array.from({ length: 80 }, (_, index) => ({ id: index, user: account(`author${index}`), body: `Original comment ${index}`, created_at: new Date(Date.UTC(2026, 9, 15, 0, index)).toISOString() })), { nextPage: 2 });
  const visited = new Set();
  const readPage = () => {
    const combined = [...api.nativeContent(current), ...api.nativeAside(current)];
    const nodes = flatten(combined);
    assert.ok(nodes.length <= 200, `Combined content has ${nodes.length} nodes`);
    assert.ok(Buffer.byteLength(JSON.stringify(combined, (key, value) => key === 'avatarBase64' ? undefined : value)) <= 185 * 1024);
    assert.ok(!nodes.some(node => node.text === 'View complete history'));
    assert.ok(nodes.some(node => node.action === 'pr-discussion-load'));
    assert.ok(nodes.some(node => node.action === 'pr-comment'));
    assert.ok(nodes.some(node => node.type === 'textEditor' && node.value === 'An unfinished reply.'));
    for (const node of nodes) {
      const match = node.type === 'markdown' && /^Original comment (\d+)$/.exec(node.text || '');
      if (match) visited.add(Number(match[1]));
    }
    return nodes;
  };
  let nodes = readPage(), steps = 0;
  assert.ok(nodes.some(node => /^pr-discussion-(?:prev|next)$/.test(node.action || '')));
  while (nodes.some(node => node.action === 'pr-discussion-prev' && !node.disabled)) {
    assert.ok(++steps <= 80, 'Earlier discussion pages must terminate');
    assert.ok(api.navigateDiscussion(current, 'prev'));
    nodes = readPage();
  }
  while (nodes.some(node => node.action === 'pr-discussion-next' && !node.disabled)) {
    assert.ok(++steps <= 160, 'Later discussion pages must terminate');
    assert.ok(api.navigateDiscussion(current, 'next'));
    nodes = readPage();
  }
  assert.deepEqual([...visited].sort((left, right) => left - right), Array.from({ length: 80 }, (_, index) => index));
});

test('The optional context column is restricted to the discussion and keeps legacy hosts on their existing structure', () => {
  const current = model();
  for (const tab of ['checks', 'commits', 'files']) {
    current.tab = tab; assert.equal(view().nativeAside(current).length, 0);
  }
  current.tab = 'discussion';
  for (const changes of [{ supportsDetailAside: false }, { supportsNativeLayout: false }, { supportsNativeTimeline: false }]) {
    const api = view(changes); assert.equal(api.nativeAside(current).length, 0);
    assert.ok(flatten(api.nativeContent(current)).some(node => node.id === 'pr-readiness'));
  }
});
