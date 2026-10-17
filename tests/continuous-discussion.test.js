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
const view = (options = {}) => createView({
  node: (type, properties = {}, children = []) => ({ type, ...properties, children }), t: en => en,
  boundedText: (value, maximum) => String(value).slice(0, maximum), displayedBody: value => value || 'No description.',
  short: (value, maximum = 512) => String(value ?? '').slice(0, maximum), itemDate: value => value.updated_at || '',
  itemStatus: () => ({ text: 'Open', tone: 'success' }), supportsNativeLayout: true, supportsNativeTimeline: true,
  supportsDetailAside: true, supportsTabBarSummary: true, supportsContinuousContent: true, ...options,
});
const model = () => ({
  key: 'owner/repo/1', repo: 'owner/repo', number: 1, generation: 1, headSHA: sha(1000), tab: 'discussion',
  item: { state: 'open', body: 'Description', user: { login: 'author' } },
  sections: Object.fromEntries(['repository', 'comments', 'reviews', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows', 'commits', 'files'].map(name => [name, section()])),
  comment: { draft: 'Untouched draft', fieldID: 'draft' }, merge: { pending: null },
});
const activityIDs = content => flatten(content).filter(value => value.id?.startsWith('pr-activity-')).map(value => value.id);
const continuous = (api, current) => {
  const content = api.nativeContent(current), all = flatten(content);
  assert.ok(!all.some(value => /^pr-(?:discussion-(?:prev|next)|commit-page-|group-page:|body:)/.test(value.action || '')), 'There must be no manual pagination actions');
  assert.ok(!all.some(value => /View complete history|Showing part of the loaded history|Content shortened/.test(value.text || '')));
  return content;
};

test('The continuous discussion keeps all 241 loaded entries in one native list', () => {
  const api = view(), current = model(), sources = ['comments', 'reviews', 'reviewComments', 'timeline'];
  for (let index = 0; index < 241; index++) {
    const name = sources[index % sources.length];
    current.sections[name].items.push({ id: index, created_at: when(index), user: { login: `person-${index}` }, actor: { login: `person-${index}` },
      body: `Original body ${index}`, ...(name === 'timeline' ? { event: 'head_ref_force_pushed', commit_id: sha(index + 1) } : {}),
      ...(name === 'reviews' ? { state: 'APPROVED' } : {}), ...(name === 'reviewComments' ? { path: 'src/main.ts', line: index + 1 } : {}) });
  }
  const content = continuous(api, current), list = flatten(content).find(value => value.id === 'pr-conversation');
  assert.equal(list.type, 'lazyColumn');
  assert.equal(activityIDs(content).length, 241);
  assert.equal(new Set(activityIDs(content)).size, 241);
  assert.equal(list.loadMoreAction, undefined);
  assert.equal(flatten(content).find(value => value.type === 'textEditor').value, current.comment.draft);
  assert.ok(!current.nativePages?.discussion, 'Current hosts must not retain a hidden pagination window');
});

test('Long descriptions and human comments retain one intact Unicode and fenced Markdown document', () => {
  const api = view(), current = model();
  const content = '# 完整文档\r\n\r\n```ts\r\n' + 'const message = "中文🙂👩‍💻";\r\n'.repeat(5000) + '```\r\n\r\n最后一段。';
  current.item.body = content;
  current.comment.draft = '"'.repeat(64 * 1024);
  current.sections.comments.items = [{ id: 1, created_at: when(1), body: content, user: { login: 'person' } }];
  const rendered = flatten(continuous(api, current));
  const documents = rendered.filter(value => value.type === 'document');
  assert.equal(documents.length, 2);
  assert.ok(documents.every(value => value.text === content));
  assert.equal(new Set(documents.map(value => value.id)).size, 2);
  assert.equal(rendered.find(value => value.type === 'textEditor').value, current.comment.draft);
});

test('A bot comment is complete inline rather than a second nested page or truncated disclosure', () => {
  const api = view(), current = model();
  const content = '## Deployment summary\n\n<details><summary>Details</summary>\n\n' + '| Package | State |\n|---|---|\n| 原生 👩‍💻 | complete |\n'.repeat(1500) + '\n</details>\n';
  current.sections.comments.items = [{ id: 1, created_at: when(1), body: content, user: { login: 'build[bot]', type: 'Bot' } }];
  const documents = flatten(continuous(api, current)).filter(value => value.type === 'document');
  assert.ok(documents.some(value => value.text === content));
  assert.ok(!documents.some(value => value.text.includes('<summary>View full comment</summary>')));
});

test('All 240 historical commits expand together, retaining order and a stable collection when more arrive', () => {
  const api = view(), current = model();
  const entry = index => ({ id: index, event: 'committed', sha: sha(index), message: `Historical commit ${index}`, author: { login: 'person', date: when(index) } });
  current.sections.timeline.items = Array.from({ length: 240 }, (_, index) => entry(index + 1));
  const header = content => flatten(content).find(value => value.action?.startsWith('pr-commits:'));
  const initial = continuous(api, current), key = header(initial).action.split(':')[1];
  assert.ok(api.toggleCommitGroup(current, key));
  const expanded = continuous(api, current), group = flatten(expanded).find(value => value.id?.startsWith('pr-commit-group-') && value.type === 'lazyColumn');
  assert.ok(group);
  const commits = group.children.filter(value => value.type === 'timelineItem');
  assert.equal(commits.length, 240);
  assert.deepEqual(Array.from(commits, value => flatten([value]).find(child => child.text?.startsWith('Historical commit ')).text),
    Array.from({ length: 240 }, (_, index) => `Historical commit ${index + 1}`));
  const ids = commits.map(value => value.id);
  current.sections.timeline.items.push(entry(241));
  const updated = continuous(api, current), updatedGroup = flatten(updated).find(value => value.id === group.id);
  assert.ok(updatedGroup, 'The visible group retains its native identity while history grows');
  assert.equal(updatedGroup.children.filter(value => value.type === 'timelineItem').length, 241);
  assert.deepEqual(updatedGroup.children.filter(value => value.type === 'timelineItem').slice(0, 240).map(value => value.id), ids);
  assert.ok(api.toggleCommitGroup(current, header(updated).action.split(':')[1]));
  assert.equal(flatten(continuous(api, current)).filter(value => value.id?.startsWith('pr-group-commit-')).length, 0);
});

test('The Commits tab contains all 211 loaded commits in a single continuous list', () => {
  const api = view(), current = model(); current.tab = 'commits';
  current.sections.commits.items = Array.from({ length: 211 }, (_, index) => ({ sha: sha(index + 1), author: { login: 'person' },
    html_url: `https://github.com/owner/repo/commit/${sha(index + 1)}`, commit: { message: `Commit ${index + 1}\n\nThe original message`, author: { date: when(index) } } }));
  const content = continuous(api, current), list = flatten(content).find(value => value.id === 'pr-commits');
  assert.equal(list.type, 'lazyColumn');
  const rows = list.children.filter(value => value.type === 'timelineItem');
  assert.equal(rows.length, 211);
  assert.equal(new Set(rows.map(value => value.id)).size, 211);
});

test('Automatic history continuation has a stable token, advances only after data changes, and stops on errors', () => {
  const api = view(), current = model();
  current.sections.timeline.items = [{ id: 1, event: 'closed', actor: { login: 'person' }, created_at: when(1) }];
  current.sections.timeline.nextPage = 2;
  const list = () => flatten(continuous(api, current)).find(value => value.id === 'pr-conversation');
  const initial = list();
  assert.equal(initial.loadMoreAction, 'pr-discussion-load');
  assert.equal(typeof initial.loadMoreToken, 'string');
  assert.ok(initial.loadMoreToken.length > 0);
  current.comment.draft = 'A different local draft';
  assert.equal(list().loadMoreToken, initial.loadMoreToken);
  current.sections.timeline.loading = true;
  assert.equal(list().loadMoreAction, undefined, 'A pending request must not start another one');
  current.sections.timeline.loading = false;
  current.sections.timeline.items.push({ id: 2, event: 'reopened', actor: { login: 'person' }, created_at: when(2) });
  current.sections.timeline.nextPage = 3;
  const next = list(); assert.notEqual(next.loadMoreToken, initial.loadMoreToken);
  current.sections.timeline.error = 'Network temporarily unavailable';
  const failed = continuous(api, current);
  assert.equal(flatten(failed).find(value => value.id === 'pr-conversation').loadMoreAction, undefined);
  assert.ok(flatten(failed).some(value => value.type === 'button' && value.action === 'pr-discussion-load' && !value.disabled));
  current.sections.timeline.error = ''; current.sections.timeline.nextPage = null;
  assert.equal(list().loadMoreAction, undefined);
});
