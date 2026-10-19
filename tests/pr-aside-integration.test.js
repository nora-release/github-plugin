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
  const { repositoryData = {}, pullData = {}, graphqlRoute = null, ...hostOptions } = options;
  const currentPull = { ...pull, ...pullData };
  return fixture({ saved: connection, supportsDetailAside: true, ...hostOptions,
    ownerAvatarRoute: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, bodyBase64: image }), route: async (url, args) => {
      if (url.pathname === '/user') return body({ login: 'viewer' });
      if (url.pathname === '/user/repos') return body([repo('team/project')]);
      if (url.pathname === '/search/issues') return searchBody([currentPull]);
      if (url.pathname === '/repos/team/project/pulls/1') return body(currentPull);
      if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: true },
        allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false, ...repositoryData });
      if (url.pathname === '/graphql') return graphqlRoute ? graphqlRoute(url, args) : assert.fail('Complete REST settings must not request GraphQL.');
      if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [{ id: 1, name: 'build', head_sha: sha, status: 'completed', conclusion: 'success' }] });
      if (url.pathname.endsWith('/status')) return body({ statuses: [] });
      if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
      if (url.pathname.endsWith('/issues/1/comments')) return body([{ id: 1, user: user('commenter', 12), body: 'An original comment.', created_at: '2026-10-16T00:00:00Z' }]);
      if (url.pathname.endsWith('/commits')) return body([]);
      return body([]);
    } });
}
async function open(f) {
  await f.renderReady({}); await f.renderReady({ action: 'kind:pulls' });
  return f.renderReady({ action: 'item:item-team/project/1' });
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
  const mergeMenu = nodes(discussion.children[1].children[0]).find(node => node.id === 'pr-merge-menu');
  assert.equal(mergeMenu?.type, 'menu', 'The real toolbar directly offers the enabled merge methods.');
  assert.equal(mergeMenu.text, 'Merge');
  assert.equal(mergeMenu.disabled, false);
  assert.deepEqual(Array.from(mergeMenu.children.filter(node => node.action?.startsWith('pr-merge:')), node => node.action), ['pr-merge:merge']);
  assert.ok(!nodes(discussion.children[1].children[0]).some(node => node.action === 'pr-toggle-merge'));
  assert.ok(detailNodes.some(node => node.action === 'pr-comment'));
  assert.equal(nodes(discussion).find(node => node.type === 'textEditor').value, 'Keep my draft.');
  const merge = await f.render({ action: mergeMenu.children.find(node => node.action === 'pr-merge:merge').action });
  assert.ok(nodes(merge).some(node => node.id === 'pr-merge-options'));
  assert.ok(nodes(merge).some(node => node.action === 'pr-confirm-merge' && !node.disabled));
  assert.ok(nodes(merge).some(node => node.text === 'Merge commit · team/project #1'));
  assert.equal(nodes(merge).find(node => node.type === 'textEditor').value, 'Keep my draft.');
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
});

test('Each toolbar merge method prepares its own confirmation without sending a write or losing the comment draft', async () => {
  const f = currentHost({ repositoryData: { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true } });
  const initial = await open(f), field = nodes(initial).find(node => node.type === 'textEditor').id;
  const menu = nodes(initial.children[1].children[0]).find(node => node.id === 'pr-merge-menu');
  assert.deepEqual(Array.from(menu.children.filter(node => node.action?.startsWith('pr-merge:')), node => node.action),
    ['pr-merge:merge', 'pr-merge:squash', 'pr-merge:rebase']);
  const draft = 'An unfinished reply.\nKeep both lines while choosing a merge method.';
  for (const [method, label] of [['merge', 'Merge commit'], ['squash', 'Squash and merge'], ['rebase', 'Rebase and merge']]) {
    const prepared = await f.render({ action: `pr-merge:${method}`, values: { [field]: draft } });
    const confirmation = nodes(prepared).find(node => node.id === 'pr-merge-options');
    assert.ok(confirmation);
    assert.ok(nodes(confirmation).some(node => node.text === `${label} · team/project #1`));
    assert.ok(nodes(confirmation).some(node => node.action === 'pr-confirm-merge' && !node.disabled));
    assert.ok(nodes(confirmation).some(node => node.text?.includes(`${sha.slice(0, 12)} into main`)));
    assert.equal(nodes(prepared).find(node => node.type === 'textEditor').value, draft);
    assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
    const canceled = await f.render({ action: 'pr-cancel-merge' });
    assert.ok(!nodes(canceled).some(node => node.action === 'pr-confirm-merge'));
    assert.equal(nodes(canceled).find(node => node.type === 'textEditor').value, draft);
  }
  assert.equal(f.writes.length, 0);
  assert.equal(f.drafts.length, 0);
});

test('The shipped SDK keeps blocked merge methods visible and offers refresh while GitHub calculates readiness', async () => {
  for (const [pullData, reason, refresh] of [
    [{ mergeable: false, mergeable_state: 'dirty' }, /conflict/i, false],
    [{ mergeable: true, mergeable_state: 'blocked' }, /rules.*block/i, false],
    [{ mergeable: true, mergeable_state: 'behind' }, /source branch/i, false],
    [{ mergeable: null, mergeable_state: 'unknown' }, /calculating merge status/i, true],
  ]) {
    const f = currentHost({ pullData }), page = await open(f);
    const menu = nodes(page.children[1].children[0]).find(node => node.id === 'pr-merge-menu');
    assert.equal(menu?.type, 'menu');
    assert.equal(menu.disabled, false);
    const methods = menu.children.filter(node => node.action?.startsWith('pr-merge:'));
    assert.equal(methods.length, 1);
    assert.equal(methods[0].disabled, true);
    assert.match(nodes(menu).map(node => node.text || '').join('\n'), reason);
    assert.equal(menu.children.some(node => node.action === 'pr-refresh'), refresh);
    assert.ok(!nodes(page).some(node => node.action === 'pr-confirm-merge'));
    assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
  }
});

test('The actual toolbar shows GraphQL merge methods when REST omits settings and preserves an explicit REST false', async () => {
  for (const explicitMerge of [undefined, false]) {
    const f = currentHost({ repositoryData: { allow_merge_commit: explicitMerge, allow_squash_merge: undefined, allow_rebase_merge: undefined },
      graphqlRoute: async (url, args) => {
        assert.equal(args.method, 'POST');
        const request = JSON.parse(args.body);
        assert.match(request.query, /^query NoraMergeSettings\(/);
        assert.doesNotMatch(request.query, /\bmutation\b/);
        assert.deepEqual(request.variables, { owner: 'team', name: 'project' });
        return body({ data: { repository: { nameWithOwner: 'TEAM/PROJECT', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true } } });
      } });
    const page = await open(f), menu = nodes(page.children[1].children[0]).find(node => node.id === 'pr-merge-menu');
    const methods = menu.children.filter(node => node.action?.startsWith('pr-merge:'));
    assert.deepEqual(Array.from(methods, node => node.action), explicitMerge === false
      ? ['pr-merge:squash', 'pr-merge:rebase'] : ['pr-merge:merge', 'pr-merge:squash', 'pr-merge:rebase']);
    assert.ok(methods.every(node => !node.disabled));
    assert.equal(f.requests.filter(request => new URL(request.url).pathname === '/graphql').length, 1);
    assert.ok(f.requests.every(request => request.method === 'GET' || request.method === 'POST' && new URL(request.url).pathname === '/graphql'));
    assert.ok(!nodes(page).some(node => node.action === 'pr-confirm-merge'));
    assert.equal(f.writes.length, 0);
  }
});

test('Unknown GraphQL settings offer an accurate refresh action that restores merge choices and the comment draft', async () => {
  let unavailable = true;
  const f = currentHost({ repositoryData: { allow_merge_commit: undefined, allow_squash_merge: undefined, allow_rebase_merge: undefined },
    graphqlRoute: async () => body(unavailable ? { errors: [{ message: 'Permission unavailable' }] }
      : { data: { repository: { nameWithOwner: 'team/project', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true } } }) });
  const page = await open(f), field = nodes(page).find(node => node.type === 'textEditor').id;
  const menu = nodes(page.children[1].children[0]).find(node => node.id === 'pr-merge-menu');
  const wording = nodes(menu).map(node => node.text || '').join('\n');
  assert.match(wording, /Could not read repository merge settings.*Refresh/i);
  assert.doesNotMatch(wording, /No merge method.*enabled/i);
  assert.ok(menu.children.some(node => node.action === 'pr-refresh' && !node.disabled));
  assert.ok(!menu.children.some(node => node.action?.startsWith('pr-merge:') && !node.disabled));
  const draft = 'Preserve this reply while settings are refreshed.';
  await f.render({ action: 'pr-tab:discussion', values: { [field]: draft } });
  unavailable = false;
  const refreshed = await f.renderReady({ action: 'pr-refresh' });
  const restoredMenu = nodes(refreshed.children[1].children[0]).find(node => node.id === 'pr-merge-menu');
  assert.deepEqual(Array.from(restoredMenu.children.filter(node => node.action?.startsWith('pr-merge:') && !node.disabled), node => node.action),
    ['pr-merge:merge', 'pr-merge:squash', 'pr-merge:rebase']);
  assert.equal(nodes(refreshed).find(node => node.type === 'textEditor').value, draft);
  assert.equal(f.requests.filter(request => new URL(request.url).pathname === '/graphql').length, 2);
  assert.ok(f.requests.every(request => request.method === 'GET' || request.method === 'POST' && new URL(request.url).pathname === '/graphql'));
  assert.equal(f.writes.length, 0);
});

test('A host without the context capability keeps its previous discussion layout even with the new plugin', async () => {
  const f = currentHost({ supportsDetailAside: false }), page = await open(f), detail = page.children[1];
  assert.ok(!detail.items?.length);
  assert.equal(nodes(detail).find(node => node.id === 'pr-description').type, 'timelineItem');
  assert.ok(nodes(detail).some(node => node.id === 'pr-readiness'));
  assert.ok(nodes(detail).some(node => node.type === 'markdown' && node.text === 'Original complete description.'));
});
