import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, connection } from './fixtures/plugin-fixture.js';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const sha = 'a'.repeat(40);
const user = (login, id) => ({ login, html_url: `https://github.com/${login}`, avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` });
const pull = issue(1, 'The actual PR title', { repository_url: 'https://api.github.com/repos/team/project', repository: { full_name: 'team/project' },
  html_url: 'https://github.com/team/project/pull/1', pull_request: {}, user: user('writer', 10), head: { sha, ref: 'feature' }, base: { ref: 'main' },
  body: 'Original complete description.', comments: 1, review_comments: 0, changed_files: 2, additions: 25, deletions: 7,
  mergeable: true, mergeable_state: 'clean', requested_reviewers: [user('reviewer', 11)], assignees: [user('assignee', 13)],
  labels: [{ name: 'bug' }], milestone: { title: 'Next release', html_url: 'https://github.com/team/project/milestone/2' },
  created_at: '2026-10-15T00:00:00Z', author_association: 'MEMBER' });
function currentHost(options = {}) {
  return fixture({ saved: connection, supportsDetailAside: true, ...options,
    ownerAvatarRoute: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, bodyBase64: image }), route: async url => {
      if (url.pathname === '/user') return body({ login: 'viewer' });
      if (url.pathname === '/user/repos') return body([repo('team/project')]);
      if (url.pathname === '/search/issues') return searchBody([pull]);
      if (url.pathname === '/repos/team/project/pulls/1') return body(pull);
      if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: true }, allow_merge_commit: true });
      if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [{ id: 1, name: 'build', head_sha: sha, status: 'completed', conclusion: 'success' }] });
      if (url.pathname.endsWith('/status')) return body({ statuses: [] });
      if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
      if (url.pathname.endsWith('/issues/1/comments')) return body([{ id: 1, user: user('commenter', 12), body: 'An original comment.', created_at: '2026-10-16T00:00:00Z' }]);
      if (url.pathname.endsWith('/commits')) return body([]);
      return body([]);
    } });
}
async function open(f) {
  await f.renderReady({}); await f.render({ action: 'kind:pulls' });
  return f.render({ action: 'item:item-team/project/1' });
}

test('The shipped SDK accepts the original comment card and loads reviewer and assignee avatars from the context column', async () => {
  const f = currentHost(); await open(f); await new Promise(resolve => setImmediate(resolve));
  const page = await f.render({}), detail = page.children[1];
  assert.equal(detail.type, 'detail');
  assert.deepEqual(Array.from(detail.children.slice(0, 3), node => node.type), ['toolbar', 'column', 'tabBar']);
  assert.equal(detail.items.length, 1); assert.equal(detail.items[0].id, 'pr-context-aside');
  assert.deepEqual(Array.from(detail.items[0].children.filter(node => node.type === 'column'), node => node.id),
    ['pr-aside-reviewers', 'pr-aside-assignees', 'pr-aside-labels', 'pr-aside-milestone', 'pr-aside-changes']);
  assert.equal(detail.items[0].children.filter(node => node.type === 'divider').length, 4);
  assert.ok(!nodes(detail.items[0]).some(node => /pr-aside-(?:comments|checks|merge)/.test(node.id || '')));
  const reviewer = nodes(detail.items[0]).find(node => node.type === 'button' && node.text === 'reviewer');
  assert.equal(reviewer.avatarBase64, image);
  const assignee = nodes(detail.items[0]).find(node => node.type === 'button' && node.text === 'assignee');
  assert.equal(assignee.avatarBase64, image);
  assert.ok(f.requests.some(request => new URL(request.url).pathname === '/u/11'));
  assert.ok(f.requests.some(request => new URL(request.url).pathname === '/u/13'));
  const description = nodes(detail).find(node => node.id === 'pr-description');
  assert.equal(description.type, 'timelineItem');
  assert.equal(description.children[0].text, 'writer');
  assert.equal(description.children[0].avatarBase64, image);
  assert.ok(nodes(description.children[1]).some(node => node.type === 'badge' && node.text === 'Member'));
  assert.ok(nodes(detail.items[0]).some(node => node.type === 'badge' && node.text === 'bug'));
  assert.ok(nodes(detail.items[0]).some(node => node.type === 'button' && node.text === 'Next release'));
  assert.equal(nodes(detail).filter(node => node.text === 'Original complete description.').length, 1);
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
});

test('Detail tabs and merge actions remain available after context cleanup and preserve the comment draft', async () => {
  const f = currentHost(); const initial = await open(f);
  const field = nodes(initial).find(node => node.type === 'textEditor').id;
  const checks = await f.render({ action: 'pr-tab:checks', values: { [field]: 'Keep my draft.' } });
  assert.ok(!checks.children[1].items?.length, 'Dedicated check views use their full content width');
  const discussion = await f.render({ action: 'pr-tab:discussion' });
  assert.equal(discussion.children[1].items[0].id, 'pr-context-aside');
  const detailNodes = discussion.children[1].children.flatMap(nodes);
  assert.ok(detailNodes.some(node => node.action === 'pr-tab:checks'));
  const mergeAction = nodes(discussion.children[1].children[0]).find(node => node.action === 'pr-toggle-merge');
  assert.ok(mergeAction, 'The real toolbar retains merge access after removing the context status');
  assert.equal(mergeAction.disabled, false);
  assert.ok(detailNodes.some(node => node.action === 'pr-comment'));
  assert.equal(nodes(discussion).find(node => node.type === 'textEditor').value, 'Keep my draft.');
  const merge = await f.render({ action: mergeAction.action });
  assert.ok(nodes(merge).some(node => node.id === 'pr-merge-options'));
  assert.ok(nodes(merge).some(node => node.action === 'pr-merge:merge'));
  assert.ok(!nodes(merge).some(node => node.action === 'pr-confirm-merge'));
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
});

test('A host without the context capability keeps its previous discussion layout even with the new plugin', async () => {
  const f = currentHost({ supportsDetailAside: false }), page = await open(f), detail = page.children[1];
  assert.ok(!detail.items?.length);
  assert.equal(nodes(detail).find(node => node.id === 'pr-description').type, 'timelineItem');
  assert.ok(nodes(detail).some(node => node.id === 'pr-readiness'));
  assert.ok(nodes(detail).some(node => node.type === 'markdown' && node.text === 'Original complete description.'));
});
