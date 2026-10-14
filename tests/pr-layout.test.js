import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const pluginSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');
const factoryStart = pluginSource.indexOf('function createPullRequestView(');
const factoryEnd = pluginSource.indexOf('const panelID', factoryStart);
assert.ok(factoryStart >= 0 && factoryEnd > factoryStart, 'The shipped plugin must contain its PR UI factory');
const createView = vm.runInNewContext(`(${pluginSource.slice(factoryStart, factoryEnd).trim()})`);
const headSHA = 'a'.repeat(40);
const section = (items = [], changes = {}) => ({ items, loaded: true, loading: false, error: '', notice: '', nextPage: null, ...changes });
const flatten = values => values.flatMap(value => [value, ...flatten(value.children || []), ...flatten(value.items || [])]);
function boundedText(value, maximum, suffix = '') {
  const text = String(value);
  if (Buffer.byteLength(text) <= maximum) return text;
  let result = '', bytes = 0;
  const limit = maximum - Buffer.byteLength(suffix);
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) break;
    result += character; bytes += size;
  }
  return result + suffix;
}
function view(locale = 'en') {
  return createView({
    node: (type, properties = {}, children = []) => ({ ...properties, type, children }),
    t: (en, zh) => locale === 'zh' ? zh : en,
    boundedText,
    displayedBody: value => boundedText(value || 'No description.', 63 * 1024, '\n\nDescription shortened.'),
    short: (value, maximum = 512) => Array.from(String(value ?? '')).slice(0, maximum).join(''),
    itemStatus: () => ({ text: 'Open', tone: 'success' }),
    itemDate: value => String(value.updated_at || value.created_at || '').slice(0, 10),
  });
}
function model() {
  return {
    key: 'owner/repo/1', repo: 'owner/repo', number: 1, headSHA, tab: 'checks',
    item: { number: 1, state: 'open', body: 'PR description', head: { ref: 'change', sha: headSHA }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean' },
    sections: {
      repository: section([], { data: { permissions: { push: true }, allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false } }),
      comments: section(), reviews: section(), reviewComments: section(), timeline: section(),
      checks: section(), statuses: section(), workflows: section(), commits: section(), files: section(),
    },
    jobsByRun: {}, comment: { draft: '', fieldID: 'pr-comment-owner/repo/1' }, merge: { pending: null },
  };
}
function run(id = 100, changes = {}) {
  return { id, name: 'Build', run_number: 7, head_sha: headSHA, status: 'in_progress', html_url: `https://github.com/owner/repo/actions/runs/${id}`, ...changes };
}
function check(id, changes = {}) {
  return { id, name: `check-${id}`, head_sha: headSHA, status: 'completed', conclusion: 'success', output: { title: 'Check result', summary: `Check summary ${id}` }, ...changes };
}

test('Thirty check runs cannot hide GitHub Actions or its native CI source controls', () => {
  const current = model();
  current.sections.checks = section(Array.from({ length: 30 }, (_, id) => check(id)));
  current.sections.workflows = section([run()]);
  const content = flatten(view().content(current));
  assert.ok(content.some(value => value.action === 'pr-jobs:100'));
  for (const source of ['actions', 'checks', 'statuses']) assert.ok(content.some(value => value.action === `pr-ci:${source}`));
  assert.ok(!content.some(value => value.text === 'Check summary 0'), 'Inactive check cards should not consume the Actions budget');
  current.checksSource = 'checks';
  const checks = flatten(view().content(current));
  assert.ok(checks.some(value => value.text === 'Check summary 0'));
  assert.ok(checks.some(value => value.action === 'pr-ci:actions'), 'Actions must remain reachable when viewing check runs');
});

test('A run with thirty jobs and fifty steps keeps the selected last job visible within the node budget', () => {
  const current = model();
  current.sections.checks = section(Array.from({ length: 30 }, (_, id) => check(id)));
  current.sections.workflows = section([run()]);
  current.selectedRunID = 100;
  current.selectedJobID = 229;
  current.jobsByRun[100] = section(Array.from({ length: 30 }, (_, index) => ({
    id: 200 + index, name: `job-${index}`, status: 'completed', conclusion: 'success',
    steps: Array.from({ length: 50 }, (_, step) => ({ number: step + 1, name: `step-${index}-${step}`, status: 'completed', conclusion: 'success' })),
  })));
  const content = flatten(view().content(current));
  assert.ok(content.some(value => value.action === 'pr-job:229' && value.value === 'selected'));
  assert.ok(content.some(value => value.text === '1 step-29-0'));
  assert.ok(content.some(value => value.text === '30 step-29-29'));
  assert.ok(!content.some(value => value.text === '1 step-0-0'), 'Other jobs must keep their steps collapsed');
  assert.ok(content.some(value => value.text?.includes('complete step list')));
  assert.ok(content.length <= 200, `Content exceeded its reserved node budget: ${content.length}`);
  assert.ok(Buffer.byteLength(JSON.stringify(content)) <= 200 * 1024, 'Visible CI details must stay bounded');
});

test('Review permission failure appears as an error instead of an endless loading state', () => {
  const current = model();
  current.sections.reviews = section([], { loaded: false, error: 'Permission denied' });
  const summary = flatten(view().summary(current));
  assert.ok(summary.some(value => value.text?.includes('Permission denied') && value.tone === 'warning'));
  assert.ok(!summary.some(value => value.text === 'Reviews loading'));
});

test('Timeline comments survive a failed comments endpoint and matching IDs are shown once', () => {
  const current = model();
  current.tab = 'discussion';
  const comment = { id: 88, body: 'Comment from timeline', user: { login: 'tester' }, created_at: '2026-10-14T00:00:00Z' };
  current.sections.comments = section([], { loaded: false, error: 'Permission denied' });
  current.sections.timeline = section([{ ...comment, event: 'commented' }]);
  let content = flatten(view().content(current));
  assert.equal(content.filter(value => value.type === 'markdown' && value.text === comment.body).length, 1);
  assert.ok(content.some(value => value.text?.includes('Permission denied')));
  current.sections.comments = section([comment]);
  content = flatten(view().content(current));
  assert.equal(content.filter(value => value.type === 'markdown' && value.text === comment.body).length, 1);
});

test('Timeline reviews and inline replies preserve fallback body, file, line, and reply metadata', () => {
  const current = model();
  current.tab = 'discussion';
  current.sections.reviews = section([], { loaded: false, error: 'Permission denied' });
  current.sections.reviewComments = section([], { loaded: false, error: 'Permission denied' });
  current.sections.timeline = section([
    { id: 99, event: 'reviewed', body: 'Requested review changes', state: 'CHANGES_REQUESTED', user: { login: 'reviewer' }, submitted_at: '2026-10-14T00:00:00Z' },
    { id: 100, event: 'line-commented', created_at: '2026-10-14T00:01:00Z', comments: [{ id: 101, body: 'Inline reply', path: 'src/main.swift', line: 42, in_reply_to_id: 100, user: { login: 'reviewer' } }] },
  ]);
  const content = flatten(view().content(current));
  assert.ok(content.some(value => value.type === 'markdown' && value.text === 'Requested review changes'));
  assert.ok(content.some(value => value.type === 'markdown' && value.text === 'Inline reply'));
  assert.ok(content.some(value => value.text?.includes('src/main.swift') && value.text.includes('line 42') && value.text.includes('Reply to #100')));
});

test('External or malformed CI links fall back to GitHub while trusted check links remain intact', () => {
  for (const url of ['https://ci.example.com/private', 'https://github.com.evil.test/run', 'https://github.com\\@evil.test/run', 'javascript:alert(1)']) {
    const current = model();
    current.checksSource = 'checks';
    current.sections.checks = section([check(1, { details_url: url })]);
    const button = flatten(view().content(current)).find(value => value.text === 'check-1' && value.type === 'button');
    assert.ok(button);
    assert.equal(decodeURIComponent(button.action.slice('pr-open:'.length)), 'https://github.com/owner/repo/pull/1/checks');
  }
  const current = model();
  current.checksSource = 'checks';
  current.sections.checks = section([check(1, { details_url: 'https://github.com/owner/repo/runs/123' })]);
  const button = flatten(view().content(current)).find(value => value.text === 'check-1' && value.type === 'button');
  assert.equal(decodeURIComponent(button.action.slice('pr-open:'.length)), 'https://github.com/owner/repo/runs/123');
});

test('Unread required checks never become a claim of merge readiness, and blocked or unknown merges have no prepare action', () => {
  const current = model();
  current.sections.checks = section([], { loaded: false, error: 'Checks permission denied' });
  current.sections.statuses = section([], { loaded: false, error: 'Status permission denied' });
  for (const state of ['blocked', 'unknown', 'dirty']) {
    current.item.mergeable_state = state;
    current.item.mergeable = state === 'unknown' ? null : state === 'dirty' ? false : true;
    const actions = flatten(view().actions(current));
    assert.ok(!actions.some(value => value.action?.startsWith('pr-merge:')), `${state} must not expose a merge preparation button`);
    assert.ok(!actions.some(value => /all checks passed|ready to merge|可以合并|全部检查通过/i.test(value.text || '')));
  }
});

test('A failed or incomplete check refresh cannot turn cached passing results into an overall green summary', () => {
  for (const changes of [{ error: 'Check refresh failed' }, { loaded: false, loading: true }, { nextPage: 2 }]) {
    const current = model();
    current.sections.checks = section([check(1)], changes);
    const summary = flatten(view().summary(current));
    const checkSummary = summary.find(value => value.type === 'badge' && /checks finished|检查.*结束/.test(value.text || ''));
    assert.ok(checkSummary, 'Cached loaded results should remain visible');
    assert.notEqual(checkSummary.tone, 'success', 'Incomplete data cannot claim overall CI success');
  }
});

test('An unavailable CI source keeps completed Actions and loaded checks explicitly partial', () => {
  const current = model();
  current.sections.checks = section([check(1)]);
  current.sections.statuses = section([], { loaded: false, error: 'Status permission denied' });
  current.sections.workflows = section([run(100, { status: 'completed', conclusion: 'success' })]);
  const summary = flatten(view().summary(current));
  for (const symbol of ['checklist', 'play.circle']) {
    const aggregate = summary.find(value => value.type === 'badge' && value.symbol === symbol);
    assert.ok(aggregate);
    assert.equal(aggregate.tone, 'warning');
    assert.match(aggregate.text, /loaded/i);
    assert.match(aggregate.text, /incomplete/i);
  }
});

test('A paginated review summary labels only the loaded reviews and avoids claiming all reviewers approved', () => {
  const current = model();
  current.sections.reviews = section([{ id: 90, state: 'APPROVED', user: { login: 'reviewer' }, submitted_at: '2026-10-14T00:00:00Z' }], { nextPage: 2 });
  const review = flatten(view().summary(current)).find(value => value.type === 'badge' && value.symbol === 'person.crop.circle.badge.checkmark');
  assert.ok(review);
  assert.match(review.text, /^Loaded reviews:/);
  assert.equal(review.tone, 'warning');
});

test('The comment editor uses the current field revision and typing does not leave the submit action permanently disabled', () => {
  const current = model();
  current.tab = 'discussion';
  current.comment.fieldID = 'pr-comment-owner/repo/1-4';
  const actions = flatten(view().actions(current));
  assert.ok(actions.some(value => value.type === 'textEditor' && value.id === 'pr-comment-owner/repo/1-4'));
  assert.ok(actions.some(value => value.action === 'pr-comment' && !value.disabled));
});
