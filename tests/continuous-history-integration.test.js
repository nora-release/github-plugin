import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, connection, deferred } from './fixtures/plugin-fixture.js';

const sha = index => index.toString(16).padStart(40, '0');
const when = index => new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString();
const pull = issue(1, 'Read every entry without leaving Nora', {
  repository: { full_name: 'team/project' }, repository_url: 'https://api.github.com/repos/team/project',
  html_url: 'https://github.com/team/project/pull/1', pull_request: {},
  head: { sha: 'a'.repeat(40), ref: 'feature' }, base: { ref: 'main' },
  user: { login: 'author' }, comments: 1, review_comments: 0,
});

function host({ timeline = [], comments = [], commits = [], description = 'Original description', beforePage = async () => null } = {}) {
  return fixture({ saved: connection, supportsDetailAside: true, supportsContinuousContent: true, route: async url => {
    if (url.pathname === '/user') return body({ login: 'viewer' });
    if (url.pathname === '/user/repos') return body([repo('team/project')]);
    if (url.pathname === '/search/issues') return searchBody([pull]);
    if (url.pathname === '/repos/team/project/pulls/1') return body({ ...pull, body: description });
    if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: false } });
    if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
    if (url.pathname.endsWith('/status')) return body({ statuses: [] });
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
    const values = url.pathname.endsWith('/timeline') ? timeline : url.pathname.endsWith('/issues/1/comments') ? comments : url.pathname.endsWith('/commits') ? commits : [];
    const page = Number(url.searchParams.get('page') || 1), end = page * 30;
    const intercepted = await beforePage(url, page);
    if (intercepted) return intercepted;
    return body(values.slice(end - 30, end), 200, end < values.length ? { link: `<https://api.github.com${url.pathname}?page=${page + 1}>; rel="next"` } : {});
  } });
}
async function open(f) {
  await f.renderReady();
  await f.render({ action: 'kind:pulls' });
  return f.renderReady({ action: 'item:item-team/project/1' });
}
const list = (view, id = 'pr-conversation') => nodes(view).find(value => value.type === 'lazyColumn' && value.id === id);
const history = view => nodes(view).filter(value => value.id?.startsWith('pr-activity-'));
const assertContinuous = view => {
  assert.ok(!nodes(view).some(value => /^pr-(?:discussion-(?:prev|next)|commit-page-|group-page:|body:)/.test(value.action || '')));
  assert.ok(!nodes(view).some(value => value.type === 'button' && ['Load more activity', 'View complete history', 'Load more commits'].includes(value.text)));
};
const assertReadOnly = f => {
  assert.deepEqual(f.links, []); assert.deepEqual(f.drafts, []);
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
};

test('The real SDK keeps all 241 events visible as scrolling appends API pages and preserves the draft', async () => {
  const timeline = Array.from({ length: 241 }, (_, index) => ({
    id: index + 1, event: 'renamed', rename: { to: `History entry ${index + 1}` },
    actor: { login: 'contributor' }, created_at: when(index),
  }));
  const f = host({ timeline });
  let page = await open(f), rounds = 0, previousIDs = [];
  const field = nodes(page).find(value => value.type === 'textEditor').id;
  const draft = 'Keep this review locally.\n\nNo comment has been posted.';
  while (true) {
    assertContinuous(page);
    const currentIDs = history(page).map(value => value.id);
    assert.deepEqual(currentIDs.slice(0, previousIDs.length), previousIDs, 'Previously visible records stay in the same list');
    assert.equal(new Set(currentIDs).size, currentIDs.length);
    const continuation = list(page);
    assert.ok(continuation);
    if (!continuation.loadMoreAction) break;
    assert.ok(++rounds < 15, 'Scrolling must eventually reach the end');
    previousIDs = currentIDs;
    const token = continuation.loadMoreToken;
    const same = await f.render({ values: { [field]: draft } });
    assert.equal(list(same).loadMoreToken, token, 'A draft update must not reset the loading sentinel');
    page = await f.render({ action: continuation.loadMoreAction, values: { [field]: draft } });
    assert.equal(nodes(page).find(value => value.type === 'textEditor').value, draft);
    if (list(page).loadMoreToken) assert.notEqual(list(page).loadMoreToken, token);
  }
  assert.equal(history(page).length, 241);
  assert.deepEqual(nodes(page).flatMap(value => {
    const match = /History entry (\d+)/.exec(value.text || '');
    return match ? [Number(match[1])] : [];
  }), Array.from({ length: 241 }, (_, index) => index + 1));
  assert.equal(f.requests.filter(value => new URL(value.url).pathname.endsWith('/timeline')).length, 9);
  assert.equal(nodes(page).find(value => value.type === 'textEditor').value, draft);
  assertReadOnly(f);
});

test('The real SDK renders an entire long Unicode description and comment across transport limits', async () => {
  const content = '# 完整内容\r\n\r\n```ts\r\n' + 'const message = "中文🙂👩‍💻";\r\n'.repeat(9000) + '```\r\n\r\n最后一段。';
  assert.ok(Buffer.byteLength(JSON.stringify({ content, second: content })) > 512 * 1024);
  const f = host({ description: content, comments: [{ id: 7, user: { login: 'reviewer' }, body: content, created_at: when(1) }] });
  const page = await open(f), documents = nodes(page).filter(value => value.type === 'document');
  assert.equal(documents.length, 2);
  assert.ok(documents.every(value => value.text === content));
  assert.ok(f.transfers.some(value => value.byteCount > 512 * 1024 && value.chunkCount > 1));
  assertContinuous(page);
  assertReadOnly(f);
});

test('The real SDK continuously renders all 211 commits without discarding the first loaded page', async () => {
  const commits = Array.from({ length: 211 }, (_, index) => ({ sha: sha(index + 1), author: { login: 'contributor' },
    commit: { message: `Commit number ${index + 1}`, author: { date: when(index) } },
  }));
  const f = host({ commits }); await open(f);
  let page = await f.render({ action: 'pr-tab:commits' }), rounds = 0, previousIDs = [];
  while (true) {
    assertContinuous(page);
    const continuation = list(page, 'pr-commits'); assert.ok(continuation);
    const rows = Array.from(continuation.children).filter(value => value.type === 'timelineItem');
    assert.deepEqual(rows.slice(0, previousIDs.length).map(value => value.id), previousIDs);
    if (!continuation.loadMoreAction) break;
    assert.ok(++rounds < 15);
    previousIDs = rows.map(value => value.id);
    page = await f.render({ action: continuation.loadMoreAction });
  }
  assert.equal(list(page, 'pr-commits').children.filter(value => value.type === 'timelineItem').length, 211);
  assert.equal(f.requests.filter(value => new URL(value.url).pathname.endsWith('/commits')).length, 8);
  assertReadOnly(f);
});

test('The real SDK expands all 240 historical commits as one collection and keeps it open when revisiting Discussion', async () => {
  const timeline = Array.from({ length: 240 }, (_, index) => ({ id: index + 1, event: 'committed', sha: sha(index + 1),
    message: `Historical commit ${index + 1}`, author: { login: 'contributor', date: when(index) },
  }));
  const f = host({ timeline }); let page = await open(f), rounds = 0;
  while (list(page).loadMoreAction) {
    assert.ok(++rounds < 15);
    page = await f.render({ action: list(page).loadMoreAction });
  }
  const header = nodes(page).find(value => value.action?.startsWith('pr-commits:'));
  assert.equal(header.text, '240 commits');
  const field = nodes(page).find(value => value.type === 'textEditor').id;
  const draft = 'This draft survives an expanded historical group';
  page = await f.render({ action: header.action, values: { [field]: draft } });
  const rows = () => nodes(page).filter(value => value.id?.startsWith('pr-group-commit-'));
  assert.equal(rows().length, 240);
  const ids = rows().map(value => value.id);
  assert.equal(new Set(ids).size, 240);
  assertContinuous(page);
  await f.render({ action: 'pr-tab:commits' });
  page = await f.render({ action: 'pr-tab:discussion' });
  assert.deepEqual(rows().map(value => value.id), ids);
  assert.equal(nodes(page).find(value => value.type === 'textEditor').value, draft);
  assertReadOnly(f);
});

test('An automatic load failure preserves existing history and uses one explicit retry without looping', async () => {
  const timeline = Array.from({ length: 61 }, (_, index) => ({ id: index + 1, event: 'closed', actor: { login: 'contributor' }, created_at: when(index) }));
  let attempts = 0;
  const f = host({ timeline, beforePage: async (url, page) => {
    if (url.pathname.endsWith('/timeline') && page === 2 && ++attempts === 1) return body({ message: 'Temporary network failure' }, 503);
  } });
  const first = await open(f), ids = history(first).map(value => value.id);
  let page = await f.render({ action: list(first).loadMoreAction });
  assert.deepEqual(history(page).map(value => value.id), ids);
  assert.equal(list(page).loadMoreAction, undefined);
  const retry = nodes(page).find(value => value.type === 'button' && value.action === 'pr-discussion-load' && !value.disabled);
  assert.ok(retry);
  await f.render({}); await f.render({});
  assert.equal(attempts, 1, 'Repainting must not repeatedly retry a failed request');
  page = await f.render({ action: retry.action });
  assert.equal(attempts, 2);
  assert.equal(history(page).length, 60);
  assert.equal(list(page).loadMoreAction, 'pr-discussion-load');
  assertReadOnly(f);
});

test('Repeated bottom visibility during an in-flight load cannot duplicate a request or erase a draft', async () => {
  const started = deferred(), release = deferred();
  const timeline = Array.from({ length: 61 }, (_, index) => ({ id: index + 1, event: 'closed', actor: { login: 'contributor' }, created_at: when(index) }));
  const f = host({ timeline, beforePage: async (url, page) => {
    if (url.pathname.endsWith('/timeline') && page === 2) { started.resolve(); await release.promise; }
  } });
  const first = await open(f), field = nodes(first).find(value => value.type === 'textEditor').id;
  const pending = f.render({ action: list(first).loadMoreAction, values: { [field]: 'Local review draft' } });
  await started.promise;
  const duplicate = await f.render({ action: 'pr-discussion-load' });
  assert.equal(list(duplicate).loadMoreAction, undefined);
  assert.equal(history(duplicate).length, 30);
  const requests = () => f.requests.filter(value => { const url = new URL(value.url); return url.pathname.endsWith('/timeline') && url.searchParams.get('page') === '2'; });
  assert.equal(requests().length, 1);
  release.resolve(); await pending;
  const ready = await f.render({});
  assert.equal(history(ready).length, 60);
  assert.equal(nodes(ready).find(value => value.type === 'textEditor').value, 'Local review draft');
  assert.equal(requests().length, 1);
  assertReadOnly(f);
});


test('Issue descriptions also render their full original document without manual body pages', async () => {
  const content = '# 原生 Issue\n\n' + '完整正文 🧑🏽‍💻\n'.repeat(35000);
  const item = issue(1, 'An Issue with a complete description', { body: content });
  const f = fixture({ saved: connection, supportsContinuousContent: true, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    if (url.pathname === '/search/issues') return searchBody([item]);
    if (url.pathname === '/repos/alice/project/issues/1') return body(item);
    return body([]);
  } });
  await f.renderReady();
  const page = await f.renderReady({ action: 'item:item-alice/project/1' });
  const description = nodes(page).find(value => value.id === 'issue-description');
  assert.ok(description);
  const documents = nodes(description).filter(value => value.type === 'document');
  assert.equal(documents.length, 1);
  assert.equal(documents[0].text, content);
  assert.ok(f.transfers.some(value => value.byteCount > 512 * 1024));
  assertContinuous(page);
  assertReadOnly(f);
});
