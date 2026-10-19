import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fixture, body, searchBody, repo, issue, nodes, connection } from './fixtures/plugin-fixture.js';

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');
const start = source.indexOf('function createPullRequestView('), end = source.indexOf('const panelID', start);
const createView = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
const sha = 'a'.repeat(40);
const section = (items = []) => ({ items, loaded: true, loading: false, error: '', notice: '', nextPage: null });
const model = () => ({ repo: 'team/project', number: 1, headSHA: sha, tab: 'discussion',
  item: { state: 'open', comments: 0, commits: 3, changed_files: 45, additions: 3363, deletions: 1373 },
  sections: Object.fromEntries(['comments', 'reviews', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows', 'commits', 'files'].map(name => [name, section()])),
});
function view(capabilities = {}, locale = 'en') {
  return createView({ node: (type, properties = {}, children = []) => ({ type, ...properties, children }),
    t: (en, zh) => locale === 'zh' ? zh : en, short: value => String(value), boundedText: value => String(value), displayedBody: value => value,
    itemStatus: () => ({ text: 'Open', tone: 'success' }), itemDate: () => '',
    supportsNativeLayout: true, supportsNativeTimeline: true, supportsDetailAside: true, ...capabilities });
}

function assertSummary(tabs, expected = ['+3363', '−1373']) {
  assert.equal(tabs.type, 'tabBar');
  assert.equal(tabs.items.length, 1);
  assert.equal(tabs.items[0].id, 'pr-change-summary');
  assert.equal(tabs.items[0].type, 'row');
  assert.deepEqual(Array.from(tabs.items[0].children, node => node.text), expected);
  assert.ok(nodes(tabs.items[0]).every(node => ['row', 'text'].includes(node.type) && !node.action), 'The trailing summary cannot create an extra action or input');
  if (expected.includes('+3363')) assert.equal(tabs.items[0].children.find(node => node.text === '+3363').tone, 'success');
  if (expected.includes('−1373')) assert.equal(tabs.items[0].children.find(node => node.text === '−1373').tone, 'danger');
}

test('Capable hosts put only changed line counts in tabBar.items on every PR tab', () => {
  const modern = view({ supportsTabBarSummary: true, supportsButtonIcon: true }), legacy = view({ supportsButtonIcon: true });
  const current = model();
  for (const selected of ['discussion', 'commits', 'checks', 'files', 'overview']) {
    current.tab = selected;
    const tabs = modern.tabs(current), previous = legacy.tabs(current);
    assertSummary(tabs);
    assert.equal(tabs.children.find(node => node.action === 'pr-tab:files').subtitle, '45');
    assert.deepEqual(tabs.children, previous.children, 'Summary placement preserves the four supplied icons, labels, counts, selection, and actions');
    assert.equal(tabs.children.find(node => node.value === 'selected').action, `pr-tab:${selected === 'overview' ? 'discussion' : selected}`);
  }
  current.tab = 'discussion';
  const aside = modern.nativeAside(current)[0];
  assert.deepEqual(Array.from(aside.children.filter(node => node.type === 'column'), node => node.id),
    ['pr-aside-reviewers', 'pr-aside-assignees', 'pr-aside-labels', 'pr-aside-milestone']);
  assert.equal(aside.children.filter(node => node.type === 'divider').length, 3);
  assert.ok(!nodes(aside).some(node => ['pr-aside-changes', 'pr-aside-comments', 'pr-aside-checks', 'pr-aside-merge'].includes(node.id)));
});

test('Hosts missing the tab summary capability retain Changes in the existing context column', () => {
  for (const capabilities of [{}, { supportsTabBarSummary: false }]) {
    const api = view(capabilities), current = model();
    assert.ok(!Object.hasOwn(api.tabs(current), 'items'));
    const aside = api.nativeAside(current)[0], changes = aside.children.find(node => node.id === 'pr-aside-changes');
    assert.ok(changes);
    assert.equal(aside.children.filter(node => node.type === 'divider').length, 4);
    assert.ok(nodes(changes).some(node => node.text === '45 files' && node.action === 'pr-tab:files'));
    assert.ok(nodes(changes).some(node => node.text === '+3363' && node.tone === 'success'));
    assert.ok(nodes(changes).some(node => node.text === '−1373' && node.tone === 'danger'));
  }
});

test('Zero change counts are displayed while unavailable or invalid metadata never invents a zero', () => {
  const api = view({ supportsTabBarSummary: true }), current = model();
  Object.assign(current.item, { changed_files: 0, additions: 0, deletions: 0 });
  assertSummary(api.tabs(current), ['+0', '−0']);
  assert.equal(api.tabs(current).children.find(node => node.action === 'pr-tab:files').subtitle, '0');
  for (const invalid of [undefined, null, '', '12', false, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    Object.assign(current.item, { changed_files: invalid, additions: invalid, deletions: invalid });
    assert.ok(!Object.hasOwn(api.tabs(current), 'items'), `No summary should be invented for ${String(invalid)}`);
  }
  current.item = { additions: 2 };
  assertSummary(api.tabs(current), ['+2']);
  current.item = { deletions: 4 };
  assertSummary(api.tabs(current), ['−4']);
  current.item = { changed_files: 6 };
  assert.ok(!Object.hasOwn(api.tabs(current), 'items'), 'A known file count alone is not a changed-lines summary');
  assert.equal(api.tabs(current).children.find(node => node.action === 'pr-tab:files').subtitle, '6');
  current.item = undefined;
  assert.ok(!Object.hasOwn(api.tabs(current), 'items'));
});

test('Chinese tabs retain the file count while the trailing summary has only line counts and no heading or icon', () => {
  const tabs = view({ supportsTabBarSummary: true }, 'zh').tabs(model());
  assertSummary(tabs);
  assert.equal(tabs.children.find(node => node.action === 'pr-tab:files').text, '文件');
  assert.equal(tabs.children.find(node => node.action === 'pr-tab:files').subtitle, '45');
  assert.ok(nodes(tabs.items[0]).every(node => !node.symbol && !node.iconSVG));
});

const pull = issue(1, 'A real PR', { repository_url: 'https://api.github.com/repos/team/project', repository: { full_name: 'team/project' },
  html_url: 'https://github.com/team/project/pull/1', pull_request: {}, user: { login: 'writer' }, head: { sha, ref: 'feature' }, base: { ref: 'main' },
  body: 'Complete original description.', comments: 0, commits: 3, changed_files: 45, additions: 3363, deletions: 1373,
  state: 'open', mergeable: true, mergeable_state: 'clean' });
function host(capability) {
  return fixture({ saved: connection, supportsDetailAside: true, supportsButtonIcon: true,
    ...(capability === undefined ? {} : { supportsTabBarSummary: capability }), route: async url => {
      if (url.pathname === '/user') return body({ login: 'viewer' });
      if (url.pathname === '/user/repos') return body([repo('team/project')]);
      if (url.pathname === '/search/issues') return searchBody([pull]);
      if (url.pathname === '/repos/team/project/pulls/1') return body(pull);
      if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: true }, allow_merge_commit: true });
      if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
      if (url.pathname.endsWith('/status')) return body({ statuses: [] });
      if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
      return body([]);
    } });
}
async function open(f) {
  await f.renderReady({}); await f.render({ action: 'kind:pulls' });
  return f.renderReady({ action: 'item:item-team/project/1' });
}

test('Actual SDK accepts the top summary and keeps it on all tabs without losing the draft or merge access', async () => {
  const f = host(true), initial = await open(f);
  const field = nodes(initial).find(node => node.type === 'textEditor').id;
  assertSummary(nodes(initial).find(node => node.id === 'pr-tabs'));
  assert.ok(!nodes(initial).some(node => node.id === 'pr-aside-changes'));
  for (const tab of ['commits', 'checks', 'files', 'discussion']) {
    const page = await f.render({ action: `pr-tab:${tab}`, ...(tab === 'commits' ? { values: { [field]: 'Keep this unfinished reply.' } } : {}) });
    assertSummary(nodes(page).find(node => node.id === 'pr-tabs'));
    assert.equal(nodes(page).find(node => node.id === 'pr-tab-files').subtitle, '45');
    assert.equal(nodes(page).find(node => node.id === `pr-tab-${tab}`).value, 'selected');
    assert.ok(nodes(page).some(node => node.action === 'pr-toggle-merge'));
    assert.ok(!nodes(page).some(node => /^pr-aside-(changes|comments|checks|merge)$/.test(node.id || '')));
    if (tab === 'discussion') {
      assert.equal(nodes(page).find(node => node.type === 'textEditor').value, 'Keep this unfinished reply.');
      const aside = nodes(page).find(node => node.id === 'pr-context-aside');
      assert.equal(aside.children.filter(node => node.type === 'column').length, 4);
      assert.equal(aside.children.filter(node => node.type === 'divider').length, 3);
    }
  }
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
});

test('Actual SDK with absent false or nonboolean capability preserves the old context summary and usable tabs', async () => {
  for (const capability of [undefined, false, 'true', 1]) {
    const f = host(capability), page = await open(f);
    const tabs = nodes(page).find(node => node.id === 'pr-tabs');
    assert.ok(!Object.hasOwn(tabs, 'items'));
    assert.ok(nodes(page).some(node => node.id === 'pr-aside-changes'));
    const files = await f.render({ action: 'pr-tab:files' });
    assert.equal(nodes(files).find(node => node.id === 'pr-tab-files').value, 'selected');
    assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
  }
});
