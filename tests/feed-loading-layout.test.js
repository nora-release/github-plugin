import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, searchBody, repo, issue, nodes, texts, connection, deferred } from './fixtures/plugin-fixture.js';

const work = (kind, number, title) => issue(number, title, {
  ...(kind === 'pulls' ? { pull_request: {}, html_url: `https://github.com/alice/project/pull/${number}` } : {}),
});
const sidebar = page => page.children[0];
const main = page => page.children[1];
const rows = page => Array.from(sidebar(page).items || [], node => node.text);
const mainPlaceholder = page => nodes(main(page)).find(node => node.type === 'emptyState');
const assertQuietSelection = (page, expected) => {
  const selection = mainPlaceholder(page);
  assert.equal(selection.text, expected);
  assert.equal(selection.textStyle, 'body');
  assert.equal(selection.tone, 'muted');
  assert.equal(selection.symbol, undefined);
  assert.equal(selection.subtitle, undefined);
  assert.equal(selection.children.length, 0);
  assert.ok(!nodes(main(page)).some(node => node.type === 'progress'));
  assert.doesNotMatch(texts(main(page)), /Loading|正在加载|正在从 GitHub/);
  return selection;
};
function loadingFixture(search, options = {}) {
  return fixture({ saved: connection, ...options, route: async url => {
    if (url.pathname === '/user') return body({ login: 'alice' });
    if (url.pathname === '/user/repos') return body([repo()]);
    assert.equal(url.pathname, '/search/issues');
    const kind = url.searchParams.get('q').startsWith('is:pull-request ') ? 'pulls' : 'issues';
    return search(kind, url);
  } });
}

test('Deferred Issue and PR switches use one localized sidebar skeleton with the same quiet main prompt before and after loading', async () => {
  for (const locale of ['en', 'zh-Hans']) for (const target of ['issues', 'pulls']) {
    const started = deferred(), release = deferred();
    let blocked = false;
    const f = loadingFixture(async kind => {
      if (blocked && kind === target) { started.resolve(); await release.promise; }
      return searchBody([work(kind, kind === 'issues' ? 1 : 2, `${kind} row`)]);
    }, { locale });
    await f.renderReady({});
    if (target === 'issues') await f.renderReady({ action: 'kind:pulls' });
    blocked = true;
    let loadingSelection;
    try {
      const page = await f.render({ action: `kind:${target}` });
      await started.promise;
      assert.deepEqual(rows(page), []);
      const progress = nodes(page).filter(node => node.type === 'progress');
      assert.equal(progress.length, 1);
      assert.equal(progress[0].id, 'github-items-loading');
      assert.equal(progress[0].appearance, 'secondary');
      assert.equal(progress[0].text, locale === 'en' ? target === 'pulls' ? 'Loading pull requests…' : 'Loading Issues…'
        : target === 'pulls' ? '正在加载 PR…' : '正在加载 Issues…');
      assert.ok(sidebar(page).children.includes(progress[0]));
      assert.equal(Object.hasOwn(sidebar(page), 'contentTransitionKey'), false, 'The skeleton uses existing SDK controls without a new host capability.');
      loadingSelection = assertQuietSelection(page, locale === 'en' ? target === 'pulls' ? 'Select a pull request' : 'Select an Issue'
        : target === 'pulls' ? '选择一条 PR' : '选择一条 Issue');
    } finally { release.resolve(); }
    const ready = await f.renderReady({});
    assert.deepEqual(rows(ready), [`${target} row`]);
    assert.equal(nodes(ready).filter(node => node.type === 'progress').length, 0);
    const readySelection = assertQuietSelection(ready, loadingSelection.text);
    assert.equal(JSON.stringify(readySelection), JSON.stringify(loadingSelection), 'Fetching the list does not swap the main area between two different empty-state designs.');
  }
});

test('Appending another page retains real rows and shows only a compact sidebar progress indicator', async () => {
  const started = deferred(), release = deferred();
  const f = loadingFixture(async (kind, url) => {
    if (url.searchParams.get('page') === '1') return searchBody([work(kind, 1, 'Existing Issue')], 200,
      { Link: '<https://api.github.com/search/issues?page=2>; rel="next"' });
    started.resolve(); await release.promise;
    return searchBody([work(kind, 2, 'Next Issue')]);
  });
  const initial = await f.renderReady({});
  const initialPrompt = assertQuietSelection(initial, 'Select an Issue');
  const append = f.render({ action: 'more-items' });
  try {
    await started.promise;
    const pending = await f.render({});
    assert.deepEqual(rows(pending), ['Existing Issue']);
    const progress = nodes(pending).filter(node => node.type === 'progress');
    assert.equal(progress.length, 1);
    assert.equal(progress[0].appearance, undefined);
    assert.equal(progress[0].id, undefined);
    assert.equal(progress[0].text, 'Loading more…');
    assert.ok(sidebar(pending).children.includes(progress[0]));
    assert.ok(!nodes(pending).some(node => node.id === 'github-items-loading'));
    assert.equal(JSON.stringify(assertQuietSelection(pending, 'Select an Issue')), JSON.stringify(initialPrompt));
  } finally { release.resolve(); }
  const ready = await append;
  assert.deepEqual(rows(ready), ['Existing Issue', 'Next Issue']);
  assert.ok(!nodes(ready).some(node => node.type === 'progress'));
});

test('A failed feed still exposes retry and a successful empty retry keeps its distinct no-results state', async () => {
  const started = deferred(), release = deferred();
  let failing = true;
  const f = loadingFixture(async kind => {
    if (kind === 'issues') return searchBody([work(kind, 1, 'Old Issue')]);
    if (failing) return body({ message: 'Temporary failure' }, 503);
    started.resolve(); await release.promise;
    return searchBody([]);
  });
  await f.renderReady({});
  const failed = await f.renderReady({ action: 'kind:pulls' });
  assert.match(texts(main(failed)), /Couldn’t load this view/);
  assert.match(texts(main(failed)), /could not be reached/i);
  assert.ok(nodes(main(failed)).some(node => node.action === 'retry-load'));
  assert.ok(!nodes(failed).some(node => node.id === 'github-items-loading'));
  failing = false;
  const retry = f.render({ action: 'retry-load' });
  try {
    await started.promise;
    const pending = await f.render({});
    assert.equal(nodes(pending).filter(node => node.id === 'github-items-loading').length, 1);
    assertQuietSelection(pending, 'Select a pull request');
    assert.doesNotMatch(texts(pending), /could not be reached/i);
  } finally { release.resolve(); }
  const empty = await retry;
  assert.deepEqual(rows(empty), []);
  assert.equal(mainPlaceholder(empty).text, 'No open pull requests');
  assert.ok(nodes(main(empty)).some(node => node.action === 'refresh'));
  assert.ok(!nodes(empty).some(node => node.type === 'progress'));
  assert.doesNotMatch(texts(empty), /could not be reached/i);
});
