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

test('The context column follows the reference sections and only exposes existing navigation actions', () => {
  const api = view(), current = model(), aside = api.nativeAside(current);
  assert.equal(aside.length, 1);
  assert.equal(aside[0].type, 'column');
  assert.equal(aside[0].id, 'pr-context-aside');
  assert.deepEqual(Array.from(aside[0].children.filter(node => node.type === 'column'), node => node.id), ['pr-aside-changes', 'pr-aside-reviewers', 'pr-aside-comments', 'pr-aside-checks', 'pr-aside-merge']);
  const nodes = flatten(aside);
  assert.ok(nodes.some(node => node.text === '60 files' && node.action === 'pr-tab:files'));
  assert.ok(nodes.some(node => node.text === '+2348' && node.tone === 'success'));
  assert.ok(nodes.some(node => node.text === '−882' && node.tone === 'danger'));
  assert.ok(nodes.some(node => node.text === 'Merge conflicts' && node.action === 'pr-toggle-merge' && node.tone === 'danger'));
  assert.ok(!nodes.some(node => /^(?:pr-merge:|pr-confirm-merge|pr-comment$)/.test(node.action || '')));
});

test('A merged context retains its semantic status when a caller supplies no custom status icon', () => {
  const current = model(); current.item.merged = true; current.item.state = 'closed'; current.item.draft = true;
  for (const tone of ['success', 'accent', 'purple']) {
    const api = view({ supportsItemRowIcon: true, itemStatus: () => ({ text: 'Open', tone }) });
    const merge = flatten(api.nativeAside(current)).find(node => node.type === 'itemRow' && node.text === 'Merged');
    assert.ok(merge);
    assert.equal(merge.tone, tone === 'purple' ? 'purple' : 'accent');
    assert.equal(merge.symbol, 'arrow.triangle.merge');
    assert.equal(merge.iconSVG, undefined);
  }
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

test('Comment totals are reported as discussion and code comments without inventing resolved thread counts', () => {
  const current = model();
  const comments = view().nativeAside(current)[0].children.find(node => node.id === 'pr-aside-comments');
  assert.match(text([comments]), /2 discussion comments/);
  assert.match(text([comments]), /3 code comments/);
  assert.doesNotMatch(text([comments]), /resolved/i);
  delete current.item.comments; delete current.item.review_comments;
  current.sections.comments = section([{ id: 1 }], { nextPage: 2 });
  const partial = view().nativeAside(current)[0].children.find(node => node.id === 'pr-aside-comments');
  assert.match(text([partial]), /1 loaded discussion comments/);
  assert.match(text([partial]), /Comment history is incomplete/);
});

test('Check summaries show real current-commit names, failed first, and preserve incomplete source warnings', () => {
  const current = model();
  current.sections.checks = section(Array.from({ length: 8 }, (_, index) => ({ id: index, name: `real-check-${index}`, head_sha: headSHA, status: 'completed', conclusion: index === 7 ? 'failure' : 'success' })));
  current.sections.checks.items.push({ id: 9, name: 'stale-check', head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure' });
  current.sections.workflows = section([], { error: 'Actions unavailable' });
  const checks = view().nativeAside(current)[0].children.find(node => node.id === 'pr-aside-checks');
  const rows = checks.children.filter(node => node.type === 'itemRow');
  assert.equal(rows.length, 6);
  assert.equal(rows[0].text, 'real-check-7'); assert.equal(rows[0].tone, 'danger');
  assert.ok(rows.every(node => node.action === 'pr-tab:checks'));
  assert.doesNotMatch(text([checks]), /stale-check/);
  assert.match(text([checks]), /Check results are incomplete/);
  assert.ok(checks.children.some(node => node.text === 'View all checks' && node.action === 'pr-tab:checks'));
});

test('Missing sources and zero results are distinct states and never imply all checks passed or all reviews approved', () => {
  const current = model(); current.item.requested_reviewers = [];
  for (const name of ['checks', 'statuses', 'workflows', 'reviews']) current.sections[name] = section([], { loaded: false, loading: true });
  const pending = text(view().nativeAside(current));
  assert.match(pending, /Checks not available yet/); assert.match(pending, /Reviewers not available yet/);
  assert.doesNotMatch(pending, /all checks passed|all.*approved|ready to merge/i);
  for (const name of ['checks', 'statuses', 'workflows', 'reviews']) current.sections[name] = section();
  const empty = text(view().nativeAside(current));
  assert.match(empty, /No checks reported/); assert.match(empty, /No reviewers/);
});

test('Main content uses an unframed original description before activity and the comment composer', () => {
  const api = view(), current = model();
  const body = api.nativeContent(current), description = body.find(node => node.id === 'pr-description');
  assert.equal(description.type, 'column'); assert.equal(description.appearance, undefined);
  assert.deepEqual(Array.from(description.children, node => node.type), ['markdown']);
  assert.equal(description.children[0].text, current.item.body);
  assert.ok(body.some(node => node.text === 'Activity'));
  assert.ok(!flatten(body).some(node => node.id === 'pr-readiness'), 'Status information moves to the context column once');
  assert.equal(body.at(-1).id, 'pr-comment-composer');
  assert.ok(flatten(body).some(node => node.type === 'textEditor' && node.value === 'An unfinished reply.'));
});

test('A partial history remains reachable and the combined discussion and context column stay in the content budget', () => {
  const current = model(), api = view();
  current.sections.comments = section(Array.from({ length: 80 }, (_, index) => ({ id: index, user: account(`author${index}`), body: `Original comment ${index}`, created_at: `2026-10-15T00:${String(index).padStart(2, '0')}:00Z` })), { nextPage: 2 });
  const combined = [...api.nativeContent(current), ...api.nativeAside(current)];
  const nodes = flatten(combined);
  assert.ok(nodes.length <= 200, `Combined content has ${nodes.length} nodes`);
  assert.ok(nodes.some(node => node.text === 'View complete history' && node.action.startsWith('pr-open:')));
  assert.ok(nodes.some(node => node.action === 'pr-more:comments'));
  assert.ok(nodes.some(node => node.type === 'markdown' && node.text === 'Original comment 79'));
  assert.ok(nodes.some(node => node.action === 'pr-comment'));
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
