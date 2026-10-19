import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, connection } from './fixtures/plugin-fixture.js';

const pull = issue(1, 'Browse the entire discussion', {
  repository: { full_name: 'team/project' }, repository_url: 'https://api.github.com/repos/team/project',
  html_url: 'https://github.com/team/project/pull/1', pull_request: {},
  head: { sha: 'a'.repeat(40), ref: 'feature' }, base: { ref: 'main' },
  user: { login: 'author' }, comments: 1, review_comments: 0,
});

function host({ timeline = [], comments = [], commits = [] } = {}) {
  return fixture({ saved: connection, supportsDetailAside: true, route: async url => {
    if (url.pathname === '/user') return body({ login: 'viewer' });
    if (url.pathname === '/user/repos') return body([repo('team/project')]);
    if (url.pathname === '/search/issues') return searchBody([pull]);
    if (url.pathname === '/repos/team/project/pulls/1') return body(pull);
    if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: false } });
    if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
    if (url.pathname.endsWith('/status')) return body({ statuses: [] });
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
    const values = url.pathname.endsWith('/timeline') ? timeline : url.pathname.endsWith('/issues/1/comments') ? comments : url.pathname.endsWith('/commits') ? commits : [];
    const page = Number(url.searchParams.get('page') || 1), end = page * 30;
    return body(values.slice(end - 30, end), 200, end < values.length ? { link: `<https://api.github.com${url.pathname}?page=${page + 1}>; rel="next"` } : {});
  } });
}
async function open(f) {
  await f.renderReady();
  await f.renderReady({ action: 'kind:pulls' });
  return f.renderReady({ action: 'item:item-team/project/1' });
}
const activeButton = (view, action) => nodes(view).find(value => value.type === 'button' && value.action === action && !value.disabled);

test('Actual SDK actions expose all 241 historical events inside Nora and preserve the local draft', async () => {
  const timeline = Array.from({ length: 241 }, (_, index) => ({
    id: index + 1, event: 'renamed', rename: { to: `History entry ${index + 1}` },
    actor: { login: 'contributor' }, created_at: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
  }));
  const f = host({ timeline });
  let page = await open(f);
  const field = nodes(page).find(value => value.type === 'textEditor').id;
  const draft = 'Keep this review locally.\n\nNo comment has been posted.';
  const found = new Set();
  let navigations = 0;
  for (; navigations < 100; navigations++) {
    for (const node of nodes(page)) {
      const match = /History entry (\d+)/.exec(node.text || '');
      if (match) found.add(Number(match[1]));
    }
    assert.ok(!nodes(page).some(value => value.text === 'View complete history'));
    const action = activeButton(page, 'pr-discussion-next')?.action || activeButton(page, 'pr-discussion-load')?.action;
    if (!action) break;
    page = await f.render({ action, values: { [field]: draft } });
    assert.equal(nodes(page).find(value => value.type === 'textEditor').value, draft);
  }
  assert.ok(navigations < 100, 'Internal history navigation must terminate');
  assert.equal(found.size, timeline.length);
  assert.deepEqual([...found].sort((a, b) => a - b), timeline.map(value => value.id));
  const timelineRequests = f.requests.filter(value => new URL(value.url).pathname.endsWith('/timeline'));
  assert.equal(timelineRequests.length, 9, 'Every API page is fetched once');
  assert.ok(activeButton(page, 'pr-discussion-prev'));
  const previous = await f.render({ action: 'pr-discussion-prev' });
  assert.ok(activeButton(previous, 'pr-discussion-next'));
  assert.equal(nodes(previous).find(value => value.type === 'textEditor').value, draft);
  assert.deepEqual(f.links, []);
  assert.deepEqual(f.drafts, []);
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
});

test('Actual SDK actions expose every long-comment segment without opening a browser', async () => {
  const content = Array.from({ length: 900 }, (_, index) => `段落 ${index + 1}：${'完整留言与审查内容 👩‍💻 '.repeat(5)}。`).join('\n\n');
  const f = host({ comments: [{ id: 7, user: { login: 'reviewer' }, body: content, created_at: '2025-01-01T00:00:00Z' }] });
  let page = await open(f), pieces = [], count = 0;
  for (; count < 100; count++) {
    const comment = nodes(page).find(value => value.type === 'timelineItem' && nodes(value).some(child => child.text === 'reviewer'));
    assert.ok(comment);
    pieces.push(...nodes(comment).filter(value => value.type === 'markdown').map(value => value.text));
    const next = nodes(comment).find(value => value.action?.startsWith('pr-body:') && value.action.endsWith(':next') && !value.disabled);
    if (!next) break;
    page = await f.render({ action: next.action });
  }
  assert.ok(count > 0 && count < 100);
  assert.equal(pieces.join(''), content);
  assert.deepEqual(f.links, []);
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
});

test('Actual SDK commit-tab paging keeps commits after the former 80 and 200 limits reachable', async () => {
  const commits = Array.from({ length: 211 }, (_, index) => ({ sha: (index + 1).toString(16).padStart(40, '0'),
    author: { login: 'contributor' }, commit: { message: `Commit number ${index + 1}`, author: { date: '2025-01-01T00:00:00Z' } },
  }));
  const f = host({ commits });
  await open(f);
  let page = await f.render({ action: 'pr-tab:commits' }), count = 0;
  const found = new Set();
  for (; count < 100; count++) {
    for (const node of nodes(page)) {
      const match = /^Commit number (\d+)$/.exec(node.text || '');
      if (match) found.add(Number(match[1]));
    }
    const action = activeButton(page, 'pr-commit-page-next')?.action || activeButton(page, 'pr-more:commits')?.action;
    if (!action) break;
    page = await f.render({ action });
  }
  assert.ok(count < 100);
  assert.equal(found.size, commits.length);
  assert.deepEqual(f.links, []);
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
});
