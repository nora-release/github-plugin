import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, repo, issue, nodes, connection } from './fixtures/plugin-fixture.js';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const user = (login, id) => ({ login, html_url: `https://github.com/${login}`, avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` });
const commits = Array.from({ length: 6 }, (_, index) => ({
  sha: String(index + 1).repeat(40), author: user(`contributor-${index + 1}`, index + 30),
  commit: { message: `Original commit title ${index + 1}`, author: { date: `2026-10-16T00:0${index + 1}:00Z` } },
}));
const pull = issue(1, 'Keep consecutive commits together', {
  repository: { full_name: 'team/project' }, repository_url: 'https://api.github.com/repos/team/project',
  html_url: 'https://github.com/team/project/pull/1', pull_request: {}, user: user('writer', 10),
  head: { sha: commits.at(-1).sha, ref: 'feature' }, base: { ref: 'main' },
  comments: 1, review_comments: 0, body: 'An original PR description.',
});
const timeline = commits.map((commit, index) => ({ id: index + 101, event: 'committed', sha: commit.sha,
  message: commit.commit.message, author: { ...commit.author, date: commit.commit.author.date } }));
function currentHost() {
  return fixture({ saved: connection, supportsDetailAside: true,
    ownerAvatarRoute: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, bodyBase64: image }),
    route: async url => {
      if (url.pathname === '/user') return body({ login: 'viewer' });
      if (url.pathname === '/user/repos') return body([repo('team/project')]);
      if (url.pathname === '/issues') return body([pull]);
      if (url.pathname === '/repos/team/project/pulls/1') return body(pull);
      if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: false } });
      if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
      if (url.pathname.endsWith('/status')) return body({ statuses: [] });
      if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
      if (url.pathname.endsWith('/issues/1/comments')) return body([{ id: 1, user: user('netlify[bot]', 20),
        body: 'A comment before all six commits.', created_at: '2026-10-16T00:00:00Z' }]);
      if (url.pathname.endsWith('/timeline')) return body(timeline);
      if (url.pathname.endsWith('/commits')) return body(commits);
      return body([]);
    } });
}
const group = page => nodes(page).find(node => node.type === 'column' && /^pr-commit-group-[a-f\d]+$/.test(node.id || ''));
const groupHeader = page => group(page)?.children.find(node => node.type === 'itemRow' && node.action?.startsWith('pr-commits:'));
const commitRows = page => group(page)?.children.filter(node => node.type === 'timelineItem') || [];
async function open(f) {
  await f.renderReady({});
  await f.render({ action: 'kind:pulls' });
  return f.render({ action: 'item:item-team/project/1' });
}
async function painted(f) {
  await new Promise(resolve => setImmediate(resolve));
  return f.render({});
}

test('The actual SDK renders one collapsed group after the comment and preserves every commit participant and link when opened', async () => {
  const f = currentHost(), initial = await open(f);
  const header = groupHeader(initial), collapsed = group(initial);
  assert.ok(header, 'The actual host must accept the full-width itemRow toggle');
  assert.equal(header.text, '6 commits');
  assert.equal(commitRows(initial).length, 0);
  const conversation = nodes(initial).find(node => node.id === 'pr-conversation');
  const comment = conversation.children.find(node => nodes(node).some(child => child.text === 'A comment before all six commits.'));
  assert.ok(comment);
  assert.equal(comment.children[0].text, 'netlify[bot]');
  assert.ok(conversation.children.indexOf(comment) < conversation.children.indexOf(collapsed));

  await f.render({ action: header.action });
  const expanded = await painted(f), rows = commitRows(expanded);
  assert.equal(group(expanded).id, collapsed.id);
  assert.equal(groupHeader(expanded).action, header.action);
  assert.equal(rows.length, 6);
  for (const [index, row] of rows.entries()) {
    const expected = commits[index], participant = row.children[0];
    assert.equal(participant.text, expected.author.login);
    assert.equal(participant.avatarBase64, image);
    assert.equal(decodeURIComponent(participant.action.slice('pr-open:'.length)), expected.author.html_url);
    assert.ok(nodes(row).some(node => node.text === expected.commit.message));
    const link = nodes(row).find(node => node.type === 'button' && node.text === expected.sha.slice(0, 8));
    assert.ok(link);
    assert.equal(decodeURIComponent(link.action.slice('pr-open:'.length)), `https://github.com/team/project/commit/${expected.sha}`);
  }
  await f.render({ action: rows[2].children[0].action });
  const commitLink = nodes(rows[2]).find(node => node.type === 'button' && node.text === commits[2].sha.slice(0, 8));
  await f.render({ action: commitLink.action });
  assert.deepEqual(f.links.slice(-2), ['https://github.com/contributor-3', `https://github.com/team/project/commit/${commits[2].sha}`]);
  const closed = await f.render({ action: groupHeader(expanded).action });
  assert.equal(group(closed).id, collapsed.id);
  assert.equal(groupHeader(closed).text, '6 commits');
  assert.equal(commitRows(closed).length, 0);
  assert.ok(nodes(closed).some(node => node.text === 'A comment before all six commits.'));
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
});

test('Opening and closing a commit group and visiting other tabs preserve the same native comment draft', async () => {
  const f = currentHost(), initial = await open(f);
  const field = nodes(initial).find(node => node.type === 'textEditor').id;
  const draft = 'A review that must remain local.\n\n- [ ] Verify the final commit';
  const expanded = await f.render({ action: groupHeader(initial).action, values: { [field]: draft } });
  const expandedID = group(expanded).id;
  assert.equal(commitRows(expanded).length, 6);
  await f.render({ action: 'pr-tab:checks' });
  await f.render({ action: 'pr-tab:commits' });
  const discussion = await f.render({ action: 'pr-tab:discussion' });
  assert.equal(group(discussion).id, expandedID);
  assert.equal(commitRows(discussion).length, 6);
  assert.equal(nodes(discussion).find(node => node.type === 'textEditor').id, field);
  assert.equal(nodes(discussion).find(node => node.type === 'textEditor').value, draft);
  const collapsed = await f.render({ action: groupHeader(discussion).action });
  assert.equal(commitRows(collapsed).length, 0);
  assert.equal(nodes(collapsed).find(node => node.type === 'textEditor').value, draft);
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
  assert.deepEqual(f.drafts, []);
});
