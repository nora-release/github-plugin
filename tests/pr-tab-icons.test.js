import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fixture, body, searchBody, repo, issue, nodes, connection } from './fixtures/plugin-fixture.js';

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');
const start = source.indexOf('function createPullRequestView('), end = source.indexOf('const panelID', start);
assert.ok(start >= 0 && end > start);
const createView = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
const commitGroupIconSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M9 12H3m12 0h6"/></g></svg>';
const expectedIcons = {
  discussion: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5"><path stroke-linecap="round" d="M7.5 12h6m-6-4h3m-2 12c1.05.87 2.315 1.424 3.764 1.519c1.141.075 2.333.075 3.473 0a4 4 0 0 0 1.188-.268c.41-.167.614-.25.719-.237c.104.012.255.122.557.342c.533.388 1.204.666 2.2.643c.503-.012.755-.019.867-.208c.113-.19-.027-.452-.308-.977c-.39-.728-.636-1.561-.262-2.229c.643-.954 1.19-2.083 1.27-3.303c.043-.655.043-1.334 0-1.99A6.7 6.7 0 0 0 21.4 11"/><path d="M12.345 17.487c3.556-.234 6.388-3.08 6.62-6.653c.046-.699.046-1.423 0-2.122c-.232-3.572-3.064-6.418-6.62-6.652c-1.213-.08-2.48-.08-3.69 0c-3.556.234-6.388 3.08-6.62 6.652c-.046.7-.046 1.423 0 2.122c.084 1.302.665 2.506 1.349 3.524c.397.712.135 1.6-.279 2.377c-.298.56-.447.84-.327 1.042s.387.209.922.221c1.057.026 1.77-.271 2.336-.685c.321-.234.482-.351.593-.365c.11-.013.328.075.763.253c.392.16.846.258 1.263.286c1.21.08 2.477.08 3.69 0Z"/></g></svg>',
  commits: commitGroupIconSVG,
  checks: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path d="M11 6h10m-10 6h10m-10 6h10"/><path stroke-linejoin="round" d="M3 7.393S4 8.045 4.5 9C4.5 9 6 5.25 8 4M3 18.393S4 19.045 4.5 20c0 0 1.5-3.75 3.5-5"/></g></svg>',
  files: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5.993 12v6M9 14.992H3M3 22h6m4 0c3.771 0 5.657 0 6.828-1.172S21 17.771 21 14v-3.343c0-.818 0-1.226-.152-1.594c-.152-.367-.441-.657-1.02-1.235l-4.736-4.736c-.499-.499-.748-.748-1.058-.896a2 2 0 0 0-.197-.082C13.514 2 13.161 2 12.456 2c-3.245 0-4.868 0-5.967.886a4 4 0 0 0-.603.603C5.144 4.41 5.023 5.7 5.004 8M14 2.5V3c0 2.828 0 4.243.879 5.121C15.757 9 17.172 9 20 9h.5"/></svg>',
};

const sha = 'a'.repeat(40);
const section = (items = []) => ({ items, loaded: true, loading: false, error: '', notice: '', nextPage: null });
const model = () => ({ repo: 'team/project', number: 1, headSHA: sha, tab: 'discussion',
  item: { comments: 0, commits: 3, changed_files: 45 },
  sections: { checks: section([{ id: 1, head_sha: sha }]), statuses: section() },
});
function view(capabilities = {}) {
  return createView({ node: (type, properties = {}, children = []) => ({ type, ...properties, children }),
    t: en => en, short: value => String(value), boundedText: value => String(value), displayedBody: value => value,
    itemStatus: () => ({ text: 'Open', tone: 'success' }), itemDate: () => '', supportsNativeLayout: true, ...capabilities });
}

test('Capable PR tabs use all four supplied SVGs while retaining order, labels, counts, selection and actions', () => {
  const modern = view({ supportsButtonIcon: true }), legacy = view(), current = model();
  for (const selected of ['discussion', 'commits', 'checks', 'files', 'overview']) {
    current.tab = selected;
    const tabs = modern.tabs(current), previous = legacy.tabs(current);
    assert.deepEqual(Array.from(tabs.children, node => node.action), ['pr-tab:discussion', 'pr-tab:commits', 'pr-tab:checks', 'pr-tab:files']);
    assert.deepEqual(Array.from(tabs.children, node => node.subtitle), ['0', '3', '1', '45']);
    assert.equal(tabs.children.filter(node => node.value === 'selected').length, 1);
    assert.equal(tabs.children.find(node => node.value === 'selected').action, `pr-tab:${selected === 'overview' ? 'discussion' : selected}`);
    for (const [index, tab] of Object.keys(expectedIcons).entries()) {
      const { iconSVG, ...unchanged } = tabs.children[index];
      assert.equal(iconSVG, expectedIcons[tab], `${tab} must use the supplied paths and stroke attributes`);
      assert.deepEqual(unchanged, previous.children[index]);
    }
  }
});

test('Missing or disabled button icons retain symbols even when collection icons are supported', () => {
  for (const capabilities of [{}, { supportsButtonIcon: false }, { supportsButtonIcon: false, supportsItemRowIcon: true }]) {
    const tabs = view(capabilities).tabs(model());
    assert.ok(tabs.children.every(node => !Object.hasOwn(node, 'iconSVG')));
    assert.deepEqual(Array.from(tabs.children, node => node.symbol), ['text.bubble', 'circle.and.line.horizontal', 'checkmark.circle', 'doc.on.doc']);
  }
});

const pull = issue(1, 'A native PR', { repository_url: 'https://api.github.com/repos/team/project', repository: { full_name: 'team/project' },
  html_url: 'https://github.com/team/project/pull/1', pull_request: {}, user: { login: 'writer' }, head: { sha, ref: 'feature' }, base: { ref: 'main' },
  body: 'Complete description.', comments: 0, commits: 3, changed_files: 45 });
function host(capability) {
  return fixture({ saved: connection, supportsDetailAside: true, ...(capability === undefined ? {} : { supportsButtonIcon: capability }), route: async url => {
    if (url.pathname === '/user') return body({ login: 'viewer' });
    if (url.pathname === '/user/repos') return body([repo('team/project')]);
    if (url.pathname === '/search/issues') return searchBody([pull]);
    if (url.pathname === '/repos/team/project/pulls/1') return body(pull);
    if (url.pathname === '/repos/team/project') return body({ ...repo('team/project'), permissions: { push: false } });
    if (url.pathname.endsWith('/check-runs')) return body({ check_runs: [] });
    if (url.pathname.endsWith('/status')) return body({ statuses: [] });
    if (url.pathname.endsWith('/actions/runs')) return body({ workflow_runs: [] });
    return body([]);
  } });
}
async function open(f) {
  await f.renderReady({}); await f.renderReady({ action: 'kind:pulls' });
  return f.renderReady({ action: 'item:item-team/project/1' });
}

test('Actual SDK buttonIcon capability renders supplied tabs and preserves the draft across all four tab actions', async () => {
  const f = host(true), initial = await open(f);
  const field = nodes(initial).find(node => node.type === 'textEditor').id;
  for (const tab of ['commits', 'checks', 'files', 'discussion']) {
    const page = await f.render({ action: `pr-tab:${tab}`, ...(tab === 'commits' ? { values: { [field]: 'Keep this draft.' } } : {}) });
    const tabs = nodes(page).find(node => node.id === 'pr-tabs');
    assert.ok(tabs, 'The panel must remain accepted by the real SDK validator');
    for (const [index, name] of Object.keys(expectedIcons).entries()) assert.equal(tabs.children[index].iconSVG, expectedIcons[name]);
    assert.equal(tabs.children.find(node => node.value === 'selected').action, `pr-tab:${tab}`);
    if (tab === 'discussion') assert.equal(nodes(page).find(node => node.type === 'textEditor').value, 'Keep this draft.');
  }
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
});

test('Actual SDK without buttonIcon keeps PR tabs usable without SVG button properties', async () => {
  for (const capability of [false, undefined]) {
    const f = host(capability), page = await open(f);
    const tabs = nodes(page).find(node => node.id === 'pr-tabs');
    assert.ok(tabs);
    assert.ok(tabs.children.every(node => !Object.hasOwn(node, 'iconSVG')));
    const files = await f.render({ action: 'pr-tab:files' });
    assert.equal(nodes(files).find(node => node.id === 'pr-tab-files').value, 'selected');
    assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
  }
});
