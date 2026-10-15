import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { deferred, issue, repo, fixture, body, nodes, texts, connection } from './fixtures/plugin-fixture.js';

const plugin = await fs.readFile(new URL('../plugin.js', import.meta.url), 'utf8');
// Exercise the shipped controller in isolation without network, UI, or GitHub mutations.
const scope = vm.createContext({ nora: { locale: 'en', ui: { node: (type, properties, children) => ({ type, ...properties, children }) }, registerPanel() {}, registerCommand() {} } });
vm.runInContext(`${plugin.replace('(() => {', '').replace(/\}\)\(\);\s*$/, '')}\nglobalThis.makePRDetails = createPullRequestDetails;`, scope);
const head = 'a'.repeat(40), newerHead = 'b'.repeat(40);
const pull = (number = 1, extra = {}) => issue(number, `Pull ${number}`, { pull_request: {}, html_url: `https://github.com/alice/project/pull/${number}`, repository: { full_name: 'alice/project' }, head: { sha: head, ref: 'feature' }, base: { ref: 'main' }, draft: false, mergeable: true, ...extra });
const repository = extra => ({ ...repo(), permissions: { push: true }, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false, ...extra });
const result = (data, headers = {}) => ({ data, headers });
const defaultRead = path => {
  if (path === '/repos/alice/project') return result(repository());
  if (/\/pulls\/\d+$/.test(path)) return result(pull(Number(path.split('/').at(-1))));
  if (path.includes('/check-runs')) return result({ check_runs: [] });
  if (path.includes('/status?')) return result({ statuses: [], state: 'pending' });
  if (path.includes('/actions/runs?')) return result({ workflow_runs: [] });
  return result([]);
};
const httpError = (message, status) => Object.assign(new Error(message), { status });
function controller({ read = defaultRead, write = async () => assert.fail('Unexpected mutation') } = {}) {
  let selected = null;
  const requests = [], writes = [], updates = [];
  const api = scope.makePRDetails({
    api: async path => { requests.push(path); return read(path); },
    write: async (path, method, body) => { writes.push({ path, method, body }); return write(path, method, body); },
    t: en => en, boundedText: (text, limit, suffix = '') => Buffer.byteLength(text) > limit ? Buffer.from(text).subarray(0, limit - Buffer.byteLength(suffix)).toString() + suffix : text,
    githubURL: url => { assert.match(url, /^https:\/\/github\.com\//); return url; },
    isCurrent: item => selected !== null && selected.repository.full_name === item.repository.full_name && selected.number === item.number,
    onUpdated: item => { selected = item; updates.push(item); },
  });
  return { api, requests, writes, updates, setSelected: item => { selected = item; }, open: async (item = pull(), options) => { selected = item; return api.open(item, options); } };
}

test('PR details load independent activity and latest-head CI; commits, files and jobs remain lazy', async () => {
  const f = controller();
  await f.open();
  assert.equal(f.api.current.tab, 'discussion');
  assert.equal(f.requests.length, 8);
  assert.ok(!f.requests.some(path => path.includes('/commits?') || path.includes('/files?') || path.includes('/jobs?')));
  for (const name of ['repository', 'reviews', 'comments', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows']) assert.equal(f.api.current.sections[name].loaded, true);
  assert.equal(f.api.current.sections.repository.data.permissions.push, true);
  for (const source of ['check-runs', '/status?', '/actions/runs?']) assert.ok(f.requests.some(path => path.includes(source) && path.includes(head)));
  await f.api.selectTab('files');
  assert.equal(f.api.current.tab, 'files');
  assert.equal(f.requests.at(-1), '/repos/alice/project/pulls/1/files?per_page=30&page=1');
});

test('Permission failure in CI does not erase comments or report checks as passed', async () => {
  const f = controller({ read: async path => path.includes('/check-runs') ? Promise.reject(httpError('Checks access denied.', 403)) : path.includes('/issues/1/comments?') ? result([{ id: 9, body: 'Useful discussion', user: { login: 'reviewer' } }]) : defaultRead(path) });
  await f.open();
  assert.equal(f.api.current.sections.comments.items[0].body, 'Useful discussion');
  assert.equal(f.api.current.sections.checks.loaded, false);
  assert.match(f.api.current.sections.checks.error, /denied/);
  assert.match(f.api.context(), /Checks access denied/);
  assert.match(f.api.context(), /Useful discussion/);
  assert.doesNotMatch(f.api.context(), /Checks.*passed/);
});

test('Late responses cannot replace another selection or a reset account', async () => {
  const started = deferred(), release = deferred();
  const f = controller({ read: async path => {
    if (path.includes('/issues/1/comments?')) { started.resolve(); await release.promise; return result([{ id: 1, body: 'Old response' }]); }
    return defaultRead(path);
  } });
  const old = f.open(pull(1));
  await started.promise;
  await f.open(pull(2));
  release.resolve(); await old;
  assert.equal(f.api.current.number, 2);
  assert.ok(!f.api.current.sections.comments.items.some(item => item.body === 'Old response'));
  f.api.reset();
  assert.equal(f.api.current, null);
  assert.equal(f.api.context(), '');
});

test('Pagination deduplicates IDs and failed append retains rows plus retry page', async () => {
  let secondAttempts = 0;
  const f = controller({ read: async path => {
    if (!path.includes('/issues/1/comments?')) return defaultRead(path);
    if (path.includes('page=1')) return result([{ id: 1, body: 'First' }], { Link: '<https://api.github.com/repos/alice/project/issues/1/comments?page=2>; rel="next"' });
    if (++secondAttempts === 1) throw httpError('Rate limited.', 429);
    return result([{ id: 1, body: 'Updated' }, { id: 2, body: 'Second' }]);
  } });
  await f.open();
  await f.api.more('comments');
  assert.equal(f.api.current.sections.comments.items[0].body, 'First');
  assert.equal(f.api.current.sections.comments.nextPage, 2);
  assert.match(f.api.current.sections.comments.error, /Rate limited/);
  await f.api.more('comments');
  assert.equal(f.api.current.sections.comments.items.length, 2);
  assert.equal(f.api.current.sections.comments.items[0].body, 'Updated');
  assert.equal(f.api.current.sections.comments.nextPage, null);
});

test('Initial section errors can retry independently, including repository permissions', async () => {
  let attempts = 0;
  const f = controller({ read: async path => {
    if (path === '/repos/alice/project' && ++attempts === 1) throw httpError('Repository access denied.', 403);
    return defaultRead(path);
  } });
  await f.open();
  assert.equal(f.api.current.sections.repository.data, null);
  assert.match(f.api.current.sections.repository.error, /denied/);
  await f.api.more('repository');
  assert.equal(f.api.current.sections.repository.data.permissions.push, true);
  assert.equal(f.api.current.sections.repository.error, '');
  assert.equal(f.api.current.sections.comments.loaded, true);
});

test('List cap stops pagination with an explicit complete-history notice', async () => {
  const f = controller({ read: async path => path.includes('/issues/1/comments?') ? result(Array.from({ length: 230 }, (_, id) => ({ id: id + 1, body: `Comment ${id}` })), { link: '<https://api.github.com/next?page=2>; rel="next"' }) : defaultRead(path) });
  await f.open();
  const section = f.api.current.sections.comments;
  assert.equal(section.items.length, 200);
  assert.equal(section.nextPage, null);
  assert.match(section.notice, /first 200/);
  const requests = f.requests.length;
  await f.api.more('comments');
  assert.equal(f.requests.length, requests);
});

test('Commit timeline records without numeric IDs deduplicate by their SHA', async () => {
  const f = controller({ read: async path => path.includes('/timeline?') ? result([{ event: 'committed', sha: head, message: 'First' }, { event: 'committed', sha: head, message: 'Updated' }]) : defaultRead(path) });
  await f.open();
  assert.equal(f.api.current.sections.timeline.loaded, true);
  assert.equal(f.api.current.sections.timeline.items.length, 1);
  assert.equal(f.api.current.sections.timeline.items[0].message, 'Updated');
});

test('Refreshing preserves the chosen tab and clears old-head checks and jobs', async () => {
  let fresh = false;
  const f = controller({ read: async path => {
    if (/\/pulls\/1$/.test(path)) { fresh = true; return result(pull(1, { head: { sha: newerHead } })); }
    if (path.includes('/check-runs')) return result({ check_runs: [{ id: fresh ? 2 : 1, head_sha: fresh ? newerHead : head, name: fresh ? 'New checks' : 'Old checks' }] });
    if (path.includes('/actions/runs?')) return result({ workflow_runs: [{ id: fresh ? 12 : 11, head_sha: fresh ? newerHead : head }] });
    if (path.includes('/actions/runs/11/jobs?')) return result({ jobs: [{ id: 33, name: 'Old job' }] });
    return defaultRead(path);
  } });
  await f.open(); await f.api.jobs(11); await f.api.selectTab('checks');
  assert.equal(f.api.current.jobsByRun[11].items[0].name, 'Old job');
  await f.api.refresh();
  assert.equal(f.api.current.tab, 'checks');
  assert.equal(f.api.current.headSHA, newerHead);
  assert.equal(f.api.current.sections.checks.items[0].name, 'New checks');
  assert.equal(Object.keys(f.api.current.jobsByRun).length, 0);
  const count = f.requests.length;
  await f.api.jobs(11);
  assert.equal(f.requests.length, count);
});

test('Workflow jobs load only on request and ignore runs from another head', async () => {
  const f = controller({ read: async path => path.includes('/actions/runs?') ? result({ workflow_runs: [{ id: 11, head_sha: head }, { id: 12, head_sha: newerHead }] }) : path.includes('/actions/runs/11/jobs?') ? result({ jobs: [{ id: 9, steps: [{ number: 1, status: 'completed' }, { number: 2, status: 'in_progress' }] }] }) : defaultRead(path) });
  await f.open();
  assert.equal(f.api.current.sections.workflows.items.length, 1);
  const count = f.requests.length;
  await f.api.jobs(12);
  assert.equal(f.requests.length, count);
  await f.api.jobs(11);
  assert.equal(f.api.current.jobsByRun[11].items[0].steps[1].status, 'in_progress');
  await f.api.jobs(11);
  assert.equal(f.requests.length, count + 1);
});

test('Invalid or missing SHA marks CI unavailable and prevents merging', async () => {
  const f = controller(); await f.open(pull(1, { head: { sha: 'not-a-sha' } }));
  assert.equal(f.requests.length, 5);
  for (const name of ['checks', 'statuses', 'workflows']) assert.match(f.api.current.sections[name].error, /latest commit/);
  f.api.prepareMerge('merge');
  assert.equal(f.api.current.merge.pending, null);
  assert.match(f.api.current.merge.error, /latest commit/);
});

test('Comments require scoped authorization and preserve exact whitespace on successful 201', async () => {
  const f = controller({ write: async (_path, _method, payload) => ({ status: 201, data: { id: 100, body: payload.body, user: { login: 'alice' } } }) });
  await f.open(); f.api.setCommentDraft('  Exact text\nwith whitespace.  ');
  await f.api.postComment();
  assert.equal(f.writes.length, 0);
  assert.match(f.api.current.comment.error, /authorize/);
  await f.api.postComment({ authorized: true });
  assert.equal(f.writes[0].path, '/repos/alice/project/issues/1/comments');
  assert.equal(f.writes[0].method, 'POST');
  assert.equal(f.writes[0].body.body, '  Exact text\nwith whitespace.  ');
  assert.equal(f.api.current.comment.draft, '');
  assert.equal(f.api.current.sections.comments.items[0].id, 100);
  assert.match(f.api.current.comment.notice, /posted/);
});

test('Blank and oversized comments are rejected, HTTP failure keeps the draft for explicit retry', async () => {
  const f = controller({ write: async () => { throw httpError('Comment access denied.', 403); } });
  await f.open(); f.api.setCommentDraft(' \n '); await f.api.postComment({ authorized: true });
  assert.equal(f.writes.length, 0);
  f.api.setCommentDraft('😀'.repeat(16385)); await f.api.postComment({ authorized: true });
  assert.equal(f.writes.length, 0);
  assert.match(f.api.current.comment.error, /64 KiB/);
  f.api.setCommentDraft('Retain me'); await f.api.postComment({ authorized: true });
  assert.equal(f.api.current.comment.draft, 'Retain me');
  assert.equal(f.api.current.comment.uncertain, false);
  assert.match(f.api.current.comment.error, /denied/);
});

test('Ambiguous comment failure prevents duplicate retry and survives same-PR refresh', async () => {
  const f = controller({ write: async () => { throw Object.assign(new Error('Transport timed out'), { uncertain: true }); } });
  await f.open(); f.api.setCommentDraft('May be posted');
  await f.api.postComment({ authorized: true });
  assert.equal(f.api.current.comment.uncertain, true);
  assert.match(f.api.current.comment.error, /Check GitHub/);
  await f.api.refresh();
  await f.api.postComment({ authorized: true });
  assert.equal(f.writes.length, 1);
  assert.equal(f.api.current.comment.draft, 'May be posted');
});

test('Malformed accepted comment responses retain the draft and require checking GitHub before retry', async () => {
  const f = controller({ write: async () => ({ status: 201, data: { body: 'Missing source ID' } }) });
  await f.open(); f.api.setCommentDraft('Potentially accepted');
  await f.api.postComment({ authorized: true });
  assert.equal(f.api.current.comment.uncertain, true);
  assert.equal(f.api.current.comment.draft, 'Potentially accepted');
  await f.api.postComment({ authorized: true });
  assert.equal(f.writes.length, 1);
});

test('Concurrent comment events and close/reopen cannot dispatch duplicate writes', async () => {
  const started = deferred(), release = deferred();
  const f = controller({ write: async (_path, _method, payload) => { started.resolve(); await release.promise; return { status: 201, data: { id: 100, body: payload.body } }; } });
  await f.open(); f.api.setCommentDraft('One comment');
  const first = f.api.postComment({ authorized: true }); await started.promise;
  await f.api.postComment({ authorized: true });
  await f.open(pull(), { preserveTab: true });
  await f.api.postComment({ authorized: true });
  assert.equal(f.writes.length, 1);
  release.resolve(); await first;
  assert.equal(f.api.current.comment.busy, false);
});

test('Merge preparation obeys repository methods, push permission, draft and conflict state', async () => {
  for (const [repoData, item, method, error] of [
    [repository({ permissions: {} }), pull(), 'merge', /Write access/],
    [repository({ allow_squash_merge: undefined }), pull(), 'squash', /not enabled/],
    [repository(), pull(1, { draft: true }), 'merge', /draft/],
    [repository(), pull(1, { state: 'closed' }), 'merge', /closed/],
    [repository(), pull(1, { mergeable: false }), 'merge', /conflicts/],
    [repository(), pull(1, { mergeable_state: 'dirty' }), 'merge', /conflicts/],
    [repository(), pull(1, { mergeable_state: 'blocked' }), 'merge', /rules.*block/],
    [repository(), pull(1, { mergeable_state: 'behind' }), 'merge', /Update.*branch/],
    [repository(), pull(1, { mergeable_state: 'unknown' }), 'merge', /calculating/],
    [repository(), pull(1, { mergeable: null }), 'merge', /calculating/],
    [repository(), pull(1, { mergeable: undefined }), 'merge', /calculating/],
    [repository({ archived: true }), pull(), 'merge', /archived/],
  ]) {
    const f = controller({ read: async path => path === '/repos/alice/project' ? result(repoData) : defaultRead(path) });
    await f.open(item); f.api.prepareMerge(method);
    assert.equal(f.api.current.merge.pending, null);
    assert.match(f.api.current.merge.error, error);
    assert.equal(f.writes.length, 0);
  }
});

test('Confirmation applies the same merge blockers to the freshly read PR', async () => {
  for (const [changes, error] of [
    [{ draft: true }, /changed/],
    [{ mergeable: false }, /conflicts/],
    [{ mergeable_state: 'dirty' }, /conflicts/],
    [{ mergeable_state: 'blocked' }, /rules.*block/],
    [{ mergeable_state: 'behind' }, /Update.*branch/],
    [{ mergeable_state: 'unknown' }, /calculating/],
    [{ mergeable: null }, /calculating/],
    [{ mergeable: undefined }, /calculating/],
  ]) {
    const f = controller({ read: async path => /\/pulls\/1$/.test(path) ? result(pull(1, changes)) : defaultRead(path) });
    await f.open(); f.api.prepareMerge('merge'); await f.api.confirmMerge({ authorized: true });
    assert.equal(f.writes.length, 0, JSON.stringify(changes));
    assert.equal(f.api.current.merge.pending, null);
    assert.match(f.api.current.merge.error, error);
    assert.equal(f.api.current.item.mergeable, pull(1, changes).mergeable);
    assert.equal(f.api.current.item.mergeable_state, changes.mergeable_state);
  }
});

test('An omitted fresh mergeable value cannot inherit cached merge readiness', async () => {
  const fresh = pull(); delete fresh.mergeable;
  const f = controller({ read: async path => /\/pulls\/1$/.test(path) ? result(fresh) : defaultRead(path) });
  await f.open(); f.api.prepareMerge('merge'); await f.api.confirmMerge({ authorized: true });
  assert.equal(f.writes.length, 0);
  assert.equal(f.api.current.item.mergeable, undefined);
  assert.equal(f.api.current.merge.pending, null);
  assert.match(f.api.current.merge.error, /calculating/);
});

test('Target repository and branch changes require confirmation again even when head SHA is unchanged', async () => {
  for (const base of [{ ref: 'release' }, { ref: 'main', repo: { full_name: 'other/project' } }, undefined]) {
    const f = controller({ read: async path => /\/pulls\/1$/.test(path) ? result(pull(1, { base })) : defaultRead(path) });
    await f.open(); f.api.prepareMerge('squash');
    assert.equal(f.api.current.merge.pending.baseRepo, 'alice/project');
    assert.equal(f.api.current.merge.pending.baseRef, 'main');
    await f.api.confirmMerge({ authorized: true });
    assert.equal(f.writes.length, 0);
    assert.equal(f.api.current.headSHA, head);
    assert.equal(f.api.current.merge.pending, null);
    assert.match(f.api.current.merge.error, /changed/);
    assert.equal(f.api.current.item.base?.ref, base?.ref);
  }
});

test('Repository owner casing alone does not change the confirmed merge target', async () => {
  const f = controller({
    read: async path => /\/pulls\/1$/.test(path) ? result(pull(1, { base: { ref: 'main', repo: { full_name: 'ALICE/PROJECT' } } })) : defaultRead(path),
    write: async () => ({ status: 200, data: { merged: true } }),
  });
  await f.open(); f.api.prepareMerge('merge'); await f.api.confirmMerge({ authorized: true });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].body.sha, head);
  assert.equal(f.api.current.item.merged, true);
});

test('A repository archived after merge preparation blocks the confirmed mutation', async () => {
  let reads = 0;
  const f = controller({ read: async path => path === '/repos/alice/project' ? result(repository({ archived: ++reads > 1 })) : defaultRead(path) });
  await f.open(); f.api.prepareMerge('merge'); await f.api.confirmMerge({ authorized: true });
  assert.equal(f.writes.length, 0);
  assert.equal(f.api.current.merge.pending, null);
  assert.match(f.api.current.merge.error, /archived/);
});

test('SHA changes between confirmation and merge refuse mutation and clear previous-head CI', async () => {
  const f = controller({ read: async path => /\/pulls\/1$/.test(path) ? result(pull(1, { head: { sha: newerHead } })) : defaultRead(path) });
  await f.open(); f.api.prepareMerge('squash'); await f.api.confirmMerge({ authorized: true });
  assert.equal(f.writes.length, 0);
  assert.equal(f.api.current.headSHA, newerHead);
  assert.equal(f.api.current.merge.pending, null);
  assert.match(f.api.current.merge.error, /changed/);
  assert.equal(f.api.current.sections.checks.loaded, false);
  assert.equal(f.updates.length, 1);
});

test('Merge requires explicit confirmation and rereads repository permission before exact-SHA PUT', async () => {
  const f = controller({ write: async () => ({ status: 200, data: { merged: true, sha: newerHead } }) });
  await f.open(); f.api.prepareMerge('squash');
  await f.api.confirmMerge(); assert.equal(f.writes.length, 0);
  await f.api.confirmMerge({ authorized: true });
  assert.deepEqual(f.writes.map(request => [request.path, request.method, request.body.sha, request.body.merge_method]), [['/repos/alice/project/pulls/1/merge', 'PUT', head, 'squash']]);
  assert.equal(f.api.current.item.merged, true);
  assert.equal(f.api.current.item.state, 'closed');
  assert.match(f.api.current.merge.notice, /merged/);
  assert.equal(f.requests.filter(path => path === '/repos/alice/project').length, 2);
});

test('Changed repository permission and server merged:false never show merge success', async () => {
  let reads = 0;
  const denied = controller({ read: async path => path === '/repos/alice/project' ? result(repository({ permissions: { push: ++reads === 1 } })) : defaultRead(path) });
  await denied.open(); denied.api.prepareMerge('merge'); await denied.api.confirmMerge({ authorized: true });
  assert.equal(denied.writes.length, 0);
  assert.match(denied.api.current.merge.error, /Write access/);
  const rejected = controller({ write: async () => ({ status: 200, data: { merged: false } }) });
  await rejected.open(); rejected.api.prepareMerge('merge'); await rejected.api.confirmMerge({ authorized: true });
  assert.equal(rejected.api.current.item.state, 'open');
  assert.equal(rejected.api.current.merge.notice, '');
  assert.equal(rejected.api.current.merge.pending, null);
  assert.match(rejected.api.current.merge.error, /did not merge/);
});

test('A selection change during confirmation prevents the PUT request', async () => {
  const started = deferred(), release = deferred();
  const f = controller({ read: async path => {
    if (/\/pulls\/1$/.test(path)) { started.resolve(); await release.promise; return result(pull()); }
    return defaultRead(path);
  } });
  await f.open(); f.api.prepareMerge('merge');
  const confirming = f.api.confirmMerge({ authorized: true }); await started.promise;
  await f.open(pull(2)); release.resolve(); await confirming;
  assert.equal(f.writes.length, 0);
  assert.equal(f.api.current.number, 2);
  assert.equal(f.api.current.merge.notice, '');
});

test('Mutation failure never auto-retries another merge method or removes the required SHA', async () => {
  const f = controller({ write: async () => { throw httpError('GitHub branch protection rejected the merge.', 405); } });
  await f.open(); f.api.prepareMerge('squash'); await f.api.confirmMerge({ authorized: true });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].body.sha, head);
  assert.equal(f.writes[0].body.merge_method, 'squash');
  assert.match(f.api.current.merge.error, /protection/);
  assert.equal(f.api.current.merge.pending, null);
  assert.equal(f.api.current.item.state, 'open');
});

test('Nora context includes CI, reviews, comments and activity without replacing original PR body', async () => {
  const original = '**Original body**\n\n| A | B |';
  const f = controller({ read: async path => path.includes('/reviews?') ? result([{ id: 1, state: 'CHANGES_REQUESTED', body: 'Add coverage', user: { login: 'bob' } }]) : path.includes('/timeline?') ? result([{ id: 2, event: 'reopened', actor: { login: 'alice' } }]) : path.includes('/check-runs?') ? result({ check_runs: [{ id: 3, name: 'Unit tests', status: 'completed', conclusion: 'failure' }] }) : defaultRead(path) });
  await f.open(pull(1, { body: original }));
  const context = f.api.context();
  assert.match(context, /Latest-commit CI checks/);
  assert.match(context, /Unit tests: failure/);
  assert.match(context, /bob: CHANGES_REQUESTED · Add coverage/);
  assert.match(context, /reopened · alice/);
  assert.equal(f.api.current.item.body, original);
  assert.equal(f.writes.length, 0);
});


async function openFixturePR(f) {
  await f.renderReady({}); await f.render({ action: 'kind:pulls' });
  return f.render({ action: 'item:item-alice/project/1' });
}
function fixtureRoute({ mutation = async () => assert.fail('Unexpected mutation'), detail = () => pull() } = {}) {
  return async (url, args) => {
    if (args.method && args.method !== 'GET') return mutation(url, args);
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repository()]);
    if (url.pathname === '/issues') return body([pull()]);
    if (url.pathname === '/repos/alice/project/pulls/1') return body(detail());
    const response = defaultRead(url.pathname + url.search);
    return body(response.data, 200, response.headers);
  };
}

test('Native panel uses a scoped post event, includes typed text, and clears the editor by changing its identity', async () => {
  const mutations = [];
  const f = fixture({ saved: connection, route: fixtureRoute({ mutation: async (url, args) => {
    mutations.push({ url, args });
    const payload = JSON.parse(args.body);
    return body({ id: 991, body: payload.body, user: { login: 'alice' } }, 201);
  } }) });
  const initial = await openFixturePR(f);
  const field = nodes(initial).find(node => node.type === 'textEditor' && node.id.startsWith('pr-comment-'));
  assert.ok(field);
  await f.renderUnscoped({ action: 'pr-comment', values: { [field.id]: 'Typed native comment' } });
  assert.equal(mutations.length, 0);
  const posted = await f.render({ action: 'pr-comment', values: { [field.id]: 'Typed native comment' } });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url.pathname, '/repos/alice/project/issues/1/comments');
  assert.equal(JSON.parse(mutations[0].args.body).body, 'Typed native comment');
  const cleared = nodes(posted).find(node => node.type === 'textEditor' && node.id.startsWith('pr-comment-'));
  assert.ok(cleared);
  assert.notEqual(cleared.id, field.id);
  assert.equal(cleared.value || '', '');
  assert.match(texts(posted), /Comment posted|Typed native comment/);
});

test('Native merge confirmation refuses a newly pushed head without sending any GitHub write', async () => {
  let changed = false;
  const f = fixture({ saved: connection, route: fixtureRoute({ detail: () => pull(1, { head: { sha: changed ? newerHead : head } }) }) });
  await openFixturePR(f);
  const prepared = await f.render({ action: 'pr-merge:merge' });
  assert.ok(nodes(prepared).some(node => node.action === 'pr-confirm-merge'));
  changed = true;
  const refused = await f.render({ action: 'pr-confirm-merge' });
  assert.match(texts(refused), /changed|confirm again/);
  assert.ok(!f.requests.some(request => request.method === 'PUT' || request.method === 'POST'));
});

test('A full PR feed with large discussion and typed draft stays within native workspace limits and keeps the selected tail', async () => {
  const largeText = (label, bytes) => `${label}/`.repeat(Math.ceil(bytes / (label.length + 1))).slice(0, bytes);
  const description = largeText('Description', 63 * 1024);
  const draft = largeText('Draft', 64 * 1024);
  const feed = Array.from({ length: 400 }, (_, index) => pull(index + 1, { body: '', title: `PR ${index + 1} / ${'Repository activity / '.repeat(11)}` }));
  const comments = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, body: largeText(`Comment ${index + 1}`, 32 * 1024), user: { login: 'reviewer' }, created_at: `2026-10-14T12:${String(index).padStart(2, '0')}:00Z` }));
  const f = fixture({ saved: connection, route: async (url, args) => {
    assert.ok(!args.method || args.method === 'GET', 'Rendering a typed draft must not write to GitHub');
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repository()]);
    if (url.pathname === '/issues') {
      const page = Number(url.searchParams.get('page'));
      const headers = page < 8 ? { link: `<https://api.github.com/issues?page=${page + 1}>; rel="next"` } : {};
      return body(feed.slice((page - 1) * 50, page * 50), 200, headers);
    }
    if (url.pathname === '/repos/alice/project/pulls/400') return body({ ...feed.at(-1), body: description });
    if (url.pathname === '/repos/alice/project/issues/400/comments') return body(comments);
    const response = defaultRead(url.pathname + url.search);
    return body(response.data, 200, response.headers);
  } });
  await f.renderReady({}); await f.render({ action: 'kind:pulls' });
  for (let page = 2; page <= 8; page++) await f.render({ action: 'more-items' });
  const selected = await f.render({ action: 'item:item-alice/project/400' });
  const editor = nodes(selected).find(node => node.type === 'textEditor' && node.id.startsWith('pr-comment-'));
  assert.ok(editor);
  const workspace = await f.render({ action: 'pr-tab:discussion', values: { [editor.id]: draft } });
  const normalized = value => ({ ...value, options: value.options || [], disabled: value.disabled || false,
    children: (value.children || []).map(normalized), items: (value.items || []).map(normalized) });
  const encoded = JSON.stringify(normalized(workspace)).replace(/\//g, '\\/');
  assert.ok(nodes(workspace).length <= 1000, `Native node count: ${nodes(workspace).length}`);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= 512 * 1024, `Native encoded bytes: ${Buffer.byteLength(encoded, 'utf8')}`);
  assert.equal(workspace.type, 'workspace');
  assert.equal(workspace.value, 'item-alice/project/400');
  assert.ok(nodes(workspace).some(node => node.action === 'item:item-alice/project/1'), 'First loaded row remains in the visible prefix');
  assert.ok(nodes(workspace).some(node => node.action === 'item:item-alice/project/400'), 'Selected last row survives sidebar shortening');
  assert.equal(nodes(workspace).find(node => node.id === editor.id)?.value, draft, 'Typed comment draft is preserved without truncation');
  assert.ok(nodes(workspace).some(node => node.type === 'markdown' && node.text === description), 'Original 63 KiB description is readable');
  assert.ok(nodes(workspace).some(node => node.type === 'markdown' && node.text.startsWith('Comment ')), 'Discussion retains actual comment content');
});

test('Native PR reading controls preserve the draft across jobs, sources and merge preparation without writing to GitHub', async () => {
  const baseRoute = fixtureRoute();
  const f = fixture({ saved: connection, route: async (url, args) => {
    assert.ok(!args.method || args.method === 'GET', 'View controls must not create a comment or merge');
    if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [{ id: 31, name: 'Lint', head_sha: head, conclusion: 'success', output: { summary: 'Selected lint result' } }] });
    if (url.pathname.includes('/commits/') && url.pathname.endsWith('/status')) return body({ statuses: [{ id: 41, context: 'External result', state: 'pending', description: 'Waiting for report' }] });
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [{ id: 81, name: 'Build', head_sha: head, status: 'completed', conclusion: 'success' }] });
    if (url.pathname.endsWith('/actions/runs/81/jobs')) return body({ jobs: [{ id: 91, name: 'First job', steps: [{ number: 1, name: 'First step', status: 'completed', conclusion: 'success' }] }, { id: 92, name: 'Second job', steps: [{ number: 1, name: 'Second step', status: 'completed', conclusion: 'success' }] }] });
    return baseRoute(url, args);
  } });
  const selected = await openFixturePR(f);
  const detail = nodes(selected).find(value => value.id === 'item-details');
  assert.equal(detail.type, 'detail');
  assert.deepEqual(Array.from(detail.children.slice(0, 3), value => value.type), ['toolbar', 'column', 'tabBar']);
  assert.ok(nodes(detail.children[0]).some(value => value.action === 'handoff-item'));
  assert.ok(nodes(detail.children[0]).some(value => value.action === 'pr-toggle-merge'));
  assert.ok(!nodes(detail).some(value => value.action?.startsWith('pr-merge:')));
  const editor = nodes(detail).find(value => value.type === 'textEditor');
  const draft = 'Preserve this native draft\nwhile reading CI.';
  await f.render({ action: 'pr-toggle-merge', values: { [editor.id]: draft } });
  await f.render({ action: 'pr-tab:checks' });
  await f.render({ action: 'pr-jobs:81' });
  let current = await f.render({ action: 'pr-job:92' });
  let split = nodes(current).find(value => value.type === 'splitView');
  assert.equal(split.value, 'detail');
  assert.ok(texts(split.children[1]).includes('Second step'));
  assert.ok(!texts(split.children[1]).includes('First step'));
  current = await f.render({ action: 'pr-ci-back' });
  assert.equal(nodes(current).find(value => value.type === 'splitView').value, 'list');
  await f.render({ action: 'pr-ci:checks' });
  current = await f.render({ action: 'pr-check:31' });
  assert.ok(texts(nodes(current).find(value => value.type === 'splitView').children[1]).includes('Selected lint result'));
  await f.render({ action: 'pr-ci:statuses' });
  current = await f.render({ action: 'pr-status:41' });
  assert.ok(texts(nodes(current).find(value => value.type === 'splitView').children[1]).includes('Waiting for report'));
  await f.render({ action: 'pr-merge:merge' });
  current = await f.render({ action: 'pr-tab:files' });
  assert.ok(nodes(current).some(value => value.action === 'pr-confirm-merge'));
  await f.render({ action: 'pr-cancel-merge' });
  current = await f.render({ action: 'pr-tab:discussion' });
  const restored = nodes(current).find(value => value.type === 'textEditor');
  assert.equal(restored.id, editor.id);
  assert.equal(restored.value, draft);
  assert.ok(!nodes(current).some(value => value.action === 'pr-confirm-merge'));
});

test('Opening native checks loads the useful workflow once and retains an explicitly selected cached workflow', async () => {
  const baseRoute = fixtureRoute(), jobReads = [];
  const f = fixture({ saved: connection, route: async (url, args) => {
    assert.ok(!args.method || args.method === 'GET', 'Opening checks is read only');
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [
      { id: 81, name: 'Skipped workflow', head_sha: head, status: 'completed', conclusion: 'skipped' },
      { id: 82, name: 'CI', head_sha: head, status: 'completed', conclusion: 'success' },
      { id: 83, name: 'Build active', head_sha: head, status: 'in_progress' },
    ] });
    const jobs = /\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
    if (jobs) {
      const id = Number(jobs[1]); jobReads.push(id);
      return body({ jobs: [{ id: id + 100, name: `Job ${id}`, steps: [{ number: 1, name: `Useful step ${id}`, status: 'completed', conclusion: 'success' }] }] });
    }
    return baseRoute(url, args);
  } });
  await openFixturePR(f);
  let current = await f.render({ action: 'pr-tab:checks' });
  assert.deepEqual(jobReads, [83]);
  assert.equal(nodes(current).find(value => value.type === 'splitView').value, 'list', 'Narrow layouts start with the loaded jobs instead of jumping into the first job');
  assert.match(texts(nodes(current).find(value => value.type === 'splitView').children[1]), /Useful step 83/);
  await f.render({ action: 'pr-tab:discussion' });
  await f.render({ action: 'pr-tab:checks' });
  assert.deepEqual(jobReads, [83], 'Returning to loaded steps cannot fetch the same jobs again');
  await f.render({ action: 'pr-jobs:82' });
  await f.render({ action: 'pr-tab:discussion' });
  current = await f.render({ action: 'pr-tab:checks' });
  assert.deepEqual(jobReads, [83, 82]);
  assert.match(texts(nodes(current).find(value => value.type === 'splitView').children[1]), /Useful step 82/);
});

test('A late automatic workflow load cannot replace the selected workflow of a different PR', async () => {
  const started = deferred(), release = deferred(), baseRoute = fixtureRoute();
  let first = true;
  const f = fixture({ saved: connection, route: async (url, args) => {
    assert.ok(!args.method || args.method === 'GET');
    if (url.pathname === '/issues') return body([pull(1), pull(2)]);
    if (/\/pulls\/[12]$/.test(url.pathname)) return body(pull(Number(url.pathname.split('/').at(-1))));
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [
      { id: 83, name: 'CI', head_sha: head, status: 'in_progress' },
      { id: 84, name: 'Selected workflow', head_sha: head, status: 'completed', conclusion: 'success' },
    ] });
    const jobs = /\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
    if (jobs) {
      const id = Number(jobs[1]);
      if (id === 83 && first) { first = false; started.resolve(); await release.promise; }
      return body({ jobs: [{ id: id + 100, name: `Job ${id}`, steps: [{ number: 1, name: `Step ${id}` }] }] });
    }
    return baseRoute(url, args);
  } });
  await openFixturePR(f);
  const old = f.render({ action: 'pr-tab:checks' });
  await started.promise;
  await f.render({ action: 'item:item-alice/project/2' });
  await f.render({ action: 'pr-tab:checks' });
  await f.render({ action: 'pr-jobs:84' });
  release.resolve();
  const current = await old;
  assert.equal(current.value, 'item-alice/project/2');
  const split = nodes(current).find(value => value.type === 'splitView');
  assert.match(texts(split.children[1]), /Step 84/);
  assert.ok(nodes(split.children[0]).some(value => value.action === 'pr-jobs:84' && value.value === 'selected'));
});
