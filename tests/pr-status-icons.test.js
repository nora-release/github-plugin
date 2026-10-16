import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, issue, nodes, connection } from './fixtures/plugin-fixture.js';

const expectedIcons = {
  open: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Huge Icons by Hugeicons - undefined --><g fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 8v8m12 0v-4c0-2.828 0-4.243-.879-5.121C16.243 6 14.828 6 12 6h-1m0 0c0-.7 1.994-2.008 2.5-2.5M11 6c0 .7 1.994 2.008 2.5 2.5"/><circle cx="6" cy="18" r="2"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/></g></svg>',
  draft: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Huge Icons by Hugeicons - undefined --><g fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 8v8"/><circle cx="6" cy="18" r="2"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path stroke-linecap="round" d="M18.125 11H18m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0Zm-.125-5H18m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0Z"/></g></svg>',
  closed: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Huge Icons by Hugeicons - undefined --><g fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 8v8m12-5v5"/><circle cx="6" cy="18" r="2"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path stroke-linecap="round" stroke-linejoin="round" d="m20 4l-2 2m0 0l-2 2m2-2l2 2m-2-2l-2-2"/></g></svg>',
};
const basics = url => url.pathname === '/user' ? body({ login: 'alice' }) : url.pathname === '/user/repos' ? body([]) : null;
const pull = (number, extra = {}) => issue(number, `PR ${number}`, { pull_request: {}, ...extra });
const detailHeading = view => view.children[1].children[1].children[0];
const detailBadge = view => detailHeading(view).children[0];
function assertHeading(view, item, kind, label) {
  const detail = view.children[1], heading = detailHeading(view);
  assert.equal(heading.type, 'row');
  assert.deepEqual(Array.from(heading.children, node => node.type), ['badge', 'text', 'text']);
  assert.equal(heading.children[0].text, label);
  assert.equal(heading.children[1].text, item.title);
  assert.equal(heading.children[1].textStyle, 'title');
  assert.equal(heading.children[2].text, `#${item.number}`);
  assert.equal(heading.children[2].textStyle, 'caption');
  assert.ok(!nodes(detail.children[0]).some(node => node.type === 'badge'));
  assert.equal(detail.children[0].children[0].text, `alice/project / ${kind} #${item.number}`);
  assert.ok(!nodes(detail.children[0]).some(node => node.action === 'close-detail' || node.symbol === 'xmark'));
  assert.equal(view.action, 'close-detail');
  assert.ok(heading.children.every(node => !node.action));
}

for (const [kind, extra, label, tone, symbol] of [
  ['open', {}, 'Open', 'success', 'arrow.triangle.pull'],
  ['draft', { draft: true }, 'Draft', 'muted', 'circle.dashed'],
  ['closed', { state: 'closed' }, 'Closed', 'danger', 'xmark.circle'],
]) {
  test(`A ${kind} PR uses the exact provided SVG in its sidebar and detail badge`, async () => {
    const item = pull(7, extra);
    const f = fixture({ saved: connection, route: async url => basics(url) || body(url.pathname === '/issues' ? [item] : item) });
    await f.renderReady({});
    const overview = await f.render({ action: 'kind:pulls' });
    const selected = await f.render({ action: 'item:item-alice/project/7' });
    assertHeading(selected, item, 'PR', label);
    for (const badge of [overview.children[0].items[0].children[0], selected.children[0].items[0].children[0], detailBadge(selected)]) {
      assert.equal(badge.type, 'badge');
      assert.equal(badge.iconSVG, expectedIcons[kind]);
      assert.equal(badge.text, label);
      assert.equal(badge.tone, tone);
      assert.equal(badge.symbol, symbol);
      assert.ok(Buffer.byteLength(badge.iconSVG) < 16 * 1024);
    }
  });
}

test('Merged PRs retain their merge symbol and take precedence over closed or draft SVGs', async () => {
  for (const extra of [{ merged_at: '2026-10-14' }, { pull_request: { merged_at: '2026-10-14' } }]) {
    const item = pull(7, { state: 'closed', draft: true, ...extra });
    const f = fixture({ saved: connection, route: async url => basics(url) || body(url.pathname === '/issues' ? [item] : item) });
    await f.renderReady({});
    await f.render({ action: 'kind:pulls' });
    const selected = await f.render({ action: 'item:item-alice/project/7' });
    assertHeading(selected, item, 'PR', 'Merged');
    for (const badge of [selected.children[0].items[0].children[0], detailBadge(selected)]) {
      assert.equal(badge.text, 'Merged');
      assert.equal(badge.tone, 'accent');
      assert.equal(badge.symbol, 'arrow.triangle.merge');
      assert.equal(badge.iconSVG, undefined);
    }
  }
});

test('Issue badges retain their semantic circles without any PR SVG', async () => {
  for (const [state, symbol, tone] of [['open', 'circle.circle', 'success'], ['closed', 'checkmark.circle', 'accent']]) {
    const item = issue(7, 'Issue 7', { state });
    const f = fixture({ saved: connection, route: async url => basics(url) || body(url.pathname === '/issues' ? [item] : item) });
    const overview = await f.renderReady({});
    const selected = await f.render({ action: 'item:item-alice/project/7' });
    assertHeading(selected, item, 'Issue', state === 'open' ? 'Open' : 'Closed');
    for (const badge of [overview.children[0].items[0].children[0], detailBadge(selected)]) {
      assert.equal(badge.iconSVG, undefined);
      assert.equal(badge.symbol, symbol);
      assert.equal(badge.tone, tone);
    }
    assert.ok(nodes(selected).every(node => node.iconSVG === undefined));
  }
});

test('A full draft PR detail updates the sidebar from the open SVG to the draft SVG', async () => {
  const item = pull(7);
  const f = fixture({ saved: connection, route: async url => basics(url) ||
    body(url.pathname === '/issues' ? [item] : { ...item, draft: true }) });
  await f.renderReady({});
  const overview = await f.render({ action: 'kind:pulls' });
  assert.equal(overview.children[0].items[0].children[0].iconSVG, expectedIcons.open);
  const selected = await f.render({ action: 'item:item-alice/project/7' });
  assert.equal(selected.children[0].items[0].children[0].iconSVG, expectedIcons.draft);
  assert.equal(detailBadge(selected).iconSVG, expectedIcons.draft);
  assert.equal(selected.children[0].items[0].id, overview.children[0].items[0].id);
});

test('Long Unicode PR and Issue titles stay bounded while their status and number remain separate', async () => {
  for (const kind of ['issues', 'pulls']) {
    const item = issue(987654, '修复 🧑🏽‍💻 editor selection '.repeat(800), kind === 'pulls' ? { pull_request: {} } : {});
    const f = fixture({ saved: connection, route: async url => basics(url) || body(url.pathname === '/issues' ? [item] : item) });
    await f.renderReady({});
    if (kind === 'pulls') await f.render({ action: 'kind:pulls' });
    const selected = await f.render({ action: 'item:item-alice/project/987654' });
    const heading = detailHeading(selected), [status, title, number] = heading.children;
    assert.equal(heading.type, 'row');
    assert.equal(status.text, 'Open');
    assert.equal(number.text, '#987654');
    assert.equal(number.textStyle, 'caption');
    assert.ok(Buffer.byteLength(title.text, 'utf8') <= 8192);
    assert.ok(title.text.endsWith('…'));
    assert.ok(!/[\ud800-\udbff]$/.test(title.text.slice(0, -1)));
    assert.equal(nodes(selected.children[1]).filter(node => node.textStyle === 'title').length, 1);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.drafts, []);
  }
});

test('Hosts without native detail support retain the previous standalone title and toolbar state', async () => {
  for (const kind of ['issues', 'pulls']) {
    const item = issue(42, 'Keep the original compatible layout', kind === 'pulls' ? { pull_request: {}, draft: true } : {});
    const f = fixture({ saved: connection, unavailableViewKinds: ['detail'],
      route: async url => basics(url) || body(url.pathname === '/issues' ? [item] : item) });
    await f.renderReady({});
    if (kind === 'pulls') await f.render({ action: 'kind:pulls' });
    const selected = await f.render({ action: 'item:item-alice/project/42' }), detail = selected.children[1];
    assert.equal(detail.type, 'column');
    assert.equal(detail.children[1].children[0].type, 'text');
    assert.equal(detail.children[1].children[0].text, item.title);
    assert.equal(detail.children[1].children[0].textStyle, 'title');
    assert.equal(detail.children[0].children.find(node => node.type === 'badge').text, kind === 'pulls' ? 'Draft' : 'Open');
    assert.ok(!detail.children[1].children.some(node => node.text === '#42'));
  }
});

test('Paginated PR SVG badges stay inside Swift encoded view and node limits', async () => {
  const f = fixture({ saved: connection, route: async url => basics(url) || body(Array.from({ length: 50 }, (_, index) => {
    const number = (Number(url.searchParams.get('page')) - 1) * 50 + index + 1;
    return pull(number, number % 3 === 0 ? { draft: true } : number % 3 === 1 ? {} : { state: 'closed' });
  }), 200, { link: '<https://api.github.com/issues?page=2>; rel="next"' }) });
  await f.renderReady({});
  let view = await f.render({ action: 'kind:pulls' });
  for (let page = 2; page <= 8; page++) view = await f.render({ action: 'more-items' });
  const withSwiftDefaults = item => ({ ...item, disabled: item.disabled || false, options: item.options || [],
    children: (item.children || []).map(withSwiftDefaults), items: (item.items || []).map(withSwiftDefaults) });
  const encoded = JSON.stringify(withSwiftDefaults(view)).replace(/\//g, '\\/');
  assert.ok(Buffer.byteLength(encoded) <= 400 * 1024);
  assert.ok(nodes(view).length <= 1000);
  assert.equal(view.children[0].items[0].id, 'item-alice/project/1');
  assert.equal(view.children[0].items.length, 400);
  assert.ok(view.children[0].items.every(item => Object.values(expectedIcons).includes(item.children[0].iconSVG)));
});
