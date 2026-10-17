import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');
const start = source.indexOf('function createPullRequestView('), end = source.indexOf('const panelID', start);
const createView = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
const flatten = values => values.flatMap(value => [value, ...flatten(value.children || []), ...flatten(value.items || [])]);
const section = (items = []) => ({ items, loaded: true, loading: false, error: '', nextPage: null, notice: '' });
const when = index => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
const sha = index => index.toString(16).padStart(40, '0');
const view = () => createView({
  node: (type, properties = {}, children = []) => ({ type, ...properties, children }), t: en => en,
  boundedText: (value, maximum) => String(value).slice(0, maximum), displayedBody: value => value || 'No description.',
  short: (value, maximum = 512) => String(value ?? '').slice(0, maximum), itemDate: value => value.updated_at || '',
  itemStatus: () => ({ text: 'Open', tone: 'success' }), supportsNativeLayout: true, supportsNativeTimeline: true,
  supportsDetailAside: true, supportsTabBarSummary: true,
});
const model = () => ({
  key: 'owner/repo/1', repo: 'owner/repo', number: 1, headSHA: sha(1000), tab: 'discussion',
  item: { state: 'open', body: 'Description', user: { login: 'author' } },
  sections: Object.fromEntries(['repository', 'comments', 'reviews', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows', 'commits', 'files'].map(name => [name, section()])),
  comment: { draft: 'Untouched draft', fieldID: 'draft' }, merge: { pending: null },
});
function validBudget(api, current) {
  const content = api.nativeContent(current), all = [...content, ...api.nativeAside(current)];
  assert.ok(flatten(all).length <= 200, `${flatten(all).length} nodes`);
  const normalize = entry => ({ ...entry, options: entry.options || [], disabled: entry.disabled || false, children: (entry.children || []).map(normalize), items: (entry.items || []).map(normalize) });
  const bytes = Buffer.byteLength(JSON.stringify(all.map(normalize)).replace(/\//g, '\\/'));
  assert.ok(bytes <= 185 * 1024, `${bytes} bytes`);
  if (current.tab === 'discussion') assert.equal(flatten(content).find(value => value.type === 'textEditor')?.value, current.comment.draft);
  assert.ok(!flatten(content).some(value => value.text === 'View complete history'));
  return content;
}
const activityIDs = content => flatten(content).filter(value => value.id?.startsWith('pr-activity-')).map(value => value.id);

test('Every loaded comment review inline reply and event stays reachable beyond eighty entries', () => {
  const api = view(), current = model();
  const sources = ['comments', 'reviews', 'reviewComments', 'timeline'];
  for (let index = 0; index < 224; index++) {
    const name = sources[index % sources.length];
    current.sections[name].items.push({ id: index, created_at: when(index), user: { login: `person-${index}` }, actor: { login: `person-${index}` },
      body: `Original body ${index}`, ...(name === 'timeline' ? { event: 'head_ref_force_pushed', commit_id: sha(index + 1) } : {}),
      ...(name === 'reviews' ? { state: 'APPROVED' } : {}), ...(name === 'reviewComments' ? { path: 'src/main.ts', line: index + 1 } : {}) });
  }
  const seen = new Set(); let pages = 0;
  do { for (const id of activityIDs(validBudget(api, current))) seen.add(id); assert.ok(++pages < 40); } while (api.navigateDiscussion(current, 'next'));
  assert.equal(seen.size, 224);
  const backwards = new Set();
  do { for (const id of activityIDs(validBudget(api, current))) backwards.add(id); } while (api.navigateDiscussion(current, 'prev'));
  assert.deepEqual(backwards, seen);
});

test('Inserted earlier records preserve a visible anchor and remain reachable by going backwards', () => {
  const api = view(), current = model();
  const comment = index => ({ id: index, created_at: when(index), user: { login: 'person' }, body: `body-${index}` });
  current.sections.comments.items = Array.from({ length: 80 }, (_, index) => comment(index + 10));
  validBudget(api, current); assert.ok(api.navigateDiscussion(current, 'next'));
  const before = activityIDs(validBudget(api, current));
  current.sections.comments.items.unshift(...Array.from({ length: 10 }, (_, index) => comment(index)));
  const after = activityIDs(validBudget(api, current));
  assert.equal(after[0], before[0]);
  while (api.navigateDiscussion(current, 'prev')) validBudget(api, current);
  assert.equal(current.nativePages.discussion.start, 0);
  assert.ok(flatten(validBudget(api, current)).some(value => value.text === 'body-0'));
});

test('Large Unicode original descriptions are complete through internal text pages beside a maximum draft', () => {
  const api = view(), current = model();
  current.comment.draft = 'draft '.repeat(10000);
  current.item.body = '中文🙂原始描述\n'.repeat(9000);
  current.sections.comments.items = [{ id: 1, created_at: when(1), body: 'Visible message', user: { login: 'person' } }];
  let original = '', pages = 0;
  do {
    const content = validBudget(api, current), card = content.find(value => value.id === 'pr-description');
    const nodes = flatten([card]); original += nodes.find(value => value.type === 'markdown').text;
    assert.ok(++pages < 100);
    const next = nodes.find(value => value.action?.endsWith(':next') && value.action.startsWith('pr-body:'));
    if (!next || !api.navigateBody(current, next.action.split(':')[1], 'next')) break;
  } while (true);
  assert.equal(original, current.item.body);
});

test('An expanded old commit collection can page every original SHA independently of the head commits endpoint', () => {
  const api = view(), current = model();
  current.sections.timeline.items = Array.from({ length: 240 }, (_, index) => ({ id: index, event: 'committed', sha: sha(index + 1),
    message: `Historical commit ${index}`, author: { login: 'person', date: when(index) } }));
  const initial = validBudget(api, current), header = flatten(initial).find(value => value.action?.startsWith('pr-commits:'));
  const key = header.action.split(':')[1]; assert.ok(api.toggleCommitGroup(current, key));
  const seen = new Set(); let pages = 0;
  do {
    const content = validBudget(api, current);
    for (const value of flatten(content)) if (value.action?.startsWith('pr-open:') && decodeURIComponent(value.action).includes('/commit/')) seen.add(decodeURIComponent(value.action).split('/commit/')[1]);
    assert.ok(++pages < 40);
  } while (api.navigateCommitGroup(current, key, 'next'));
  assert.equal(seen.size, 240);
  assert.equal(current.sections.commits.items.length, 0);
  assert.ok(api.toggleCommitGroup(current, key));
});

test('The Commits tab pages every loaded commit beyond the old eighty item cap', () => {
  const api = view(), current = model(); current.tab = 'commits';
  current.sections.commits.items = Array.from({ length: 160 }, (_, index) => ({ sha: sha(index + 1), author: { login: 'person' },
    html_url: `https://github.com/owner/repo/commit/${sha(index + 1)}`, commit: { message: `Commit ${index}\n\nThe original message`, author: { date: when(index) } } }));
  const seen = new Set(); let pages = 0;
  do {
    for (const value of flatten(validBudget(api, current))) if (value.type === 'timelineItem') seen.add(value.id);
    assert.ok(++pages < 40);
  } while (api.navigateCommits(current, 'next'));
  assert.equal(seen.size, 160);
});

test('Different timeline events on the same commit keep distinct anchors and never loop while paging', () => {
  const api = view(), current = model();
  current.sections.timeline.items = Array.from({ length: 150 }, (_, index) => ({ id: index, created_at: when(index), commit_id: sha(900),
    event: index % 2 ? 'closed' : 'reopened', actor: { login: 'person' } }));
  const seen = new Set(); let pages = 0;
  do { for (const id of activityIDs(validBudget(api, current))) seen.add(id); assert.ok(++pages < 20); } while (api.navigateDiscussion(current, 'next'));
  assert.equal(seen.size, 150);
});

test('A growing commit collection preserves its visible SHA anchor after its grouping key changes', () => {
  const api = view(), current = model();
  const commit = index => ({ id: index, event: 'committed', sha: sha(index), message: `Original ${index}`, author: { login: 'person', date: when(index) } });
  current.sections.timeline.items = Array.from({ length: 100 }, (_, index) => commit(index + 1));
  const header = content => flatten(content).find(value => value.action?.startsWith('pr-commits:'));
  const key = header(validBudget(api, current)).action.split(':')[1];
  api.toggleCommitGroup(current, key); validBudget(api, current); assert.ok(api.navigateCommitGroup(current, key, 'next'));
  validBudget(api, current); const anchor = current.nativePages[`group-${key}`].anchor;
  current.sections.timeline.items.push(commit(101));
  const nextKey = header(validBudget(api, current)).action.split(':')[1];
  assert.notEqual(nextKey, key); assert.equal(current.nativePages[`group-${nextKey}`].anchor, anchor);
  assert.equal(current.nativePages[`group-${key}`], undefined);
});

test('Long fenced code stays rendered as code on every text page without losing original source', () => {
  const api = view(), current = model();
  current.item.body = '```ts\n' + 'const message = "中文🙂";\n'.repeat(1500) + '```\n';
  let rebuilt = '', index = 0;
  do {
    const description = validBudget(api, current).find(value => value.id === 'pr-description'), nodes = flatten([description]);
    let text = nodes.find(value => value.type === 'markdown').text;
    assert.ok(text.startsWith('```ts\n'));
    const next = nodes.find(value => value.action?.startsWith('pr-body:') && value.action.endsWith(':next'));
    if (index > 0) text = text.slice('```ts\n'.length);
    if (!next.disabled) { assert.ok(text.endsWith('\n```')); text = text.slice(0, -'\n```'.length); }
    rebuilt += text; index++;
    if (!api.navigateBody(current, next.action.split(':')[1], 'next')) break;
  } while (index < 20);
  assert.equal(rebuilt, current.item.body);
});

test('A quote-heavy maximum draft cannot consume the first discussion entry or overflow the descriptor', () => {
  const api = view(), current = model();
  current.comment.draft = '"'.repeat(64 * 1024); current.item.body = '"'.repeat(12 * 1024);
  const account = index => ({ login: `${index}`.padEnd(39, 'p') });
  current.item.requested_reviewers = Array.from({ length: 6 }, (_, index) => account(index));
  current.item.assignees = Array.from({ length: 6 }, (_, index) => account(index + 6));
  current.item.labels = Array.from({ length: 8 }, (_, index) => `${index}`.padEnd(49, 'l'));
  current.item.milestone = { title: 'm'.repeat(250) };
  current.sections.comments.items = [1, 2].map(id => ({ id, created_at: when(id), user: account(id), body: '"'.repeat(12 * 1024) }));
  const seen = new Set(); let pages = 0;
  do {
    const content = validBudget(api, current), ids = activityIDs(content);
    assert.ok(ids.length, 'Every visible discussion page must display an actual original entry');
    for (const id of ids) seen.add(id);
    assert.ok(++pages < 10);
  } while (api.navigateDiscussion(current, 'next'));
  assert.equal(seen.size, 2);
  assert.equal(current.comment.draft.length, 64 * 1024);
});
