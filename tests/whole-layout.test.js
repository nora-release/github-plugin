import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, body, nodes, texts, connection } from './fixtures/plugin-fixture.js';

test('Issues use the same fixed native detail structure and preserve read-only actions', async () => {
  const f = fixture({ saved: connection });
  const overview = await f.renderReady({});
  assert.ok(nodes(overview.children[0]).some(value => value.id === 'github-feed-controls' && value.appearance === 'plain'));
  const selected = await f.renderReady({ action: 'item:item-alice/project/1' });
  const detail = selected.children[1];
  assert.equal(detail.type, 'detail');
  assert.deepEqual(Array.from(detail.children.slice(0, 3), value => value.type), ['toolbar', 'column', 'tabBar']);
  const description = nodes(detail).find(value => value.id === 'issue-description');
  assert.equal(description.type, 'timelineItem');
  assert.equal(description.value, 'comment');
  assert.ok(nodes(description).some(value => value.type === 'markdown' && value.text === 'Description'));
  assert.ok(nodes(detail.children[0]).some(value => value.action === 'handoff-item'));
  for (const action of ['refresh-detail', 'open-item']) assert.ok(nodes(detail).some(value => value.action === action));
  assert.ok(!nodes(detail.children[0]).some(value => value.action === 'close-detail' || value.symbol === 'xmark'));
  assert.equal(selected.action, 'close-detail');
  assert.equal(selected.value, 'item-alice/project/1');
  assert.ok(!nodes(detail).some(value => value.type === 'textEditor' || /^(pr-comment|pr-toggle-merge|pr-merge:|pr-confirm-merge)/.test(value.action || '')));
  assert.ok(f.requests.every(request => !request.method || request.method === 'GET'));
  assert.equal(f.writes.length, 0);
  const closed = await f.render({ action: selected.action });
  assert.equal(closed.value, '');
  assert.equal(closed.children[0].value, '');
  assert.ok(!nodes(closed).some(value => value.id === 'item-details'));
});

test('Older Nora hosts retain the compatible Issue description without unsupported detail views', async () => {
  const f = fixture({ saved: connection, unavailableViewKinds: ['detail'] });
  await f.renderReady({});
  const selected = await f.renderReady({ action: 'item:item-alice/project/1' });
  assert.equal(selected.children[1].type, 'column');
  assert.ok(nodes(selected).some(value => value.type === 'markdown' && value.text === 'Description'));
  assert.ok(nodes(selected).some(value => value.action === 'handoff-item'));
  assert.ok(nodes(selected.children[1].children[0]).some(value => value.action === 'close-detail' && value.symbol === 'xmark'));
  assert.ok(!nodes(selected).some(value => value.type === 'detail'));
});

test('Hosts without timeline layout retain the existing author and complete Issue body', async () => {
  const f = fixture({ saved: connection, unavailableViewKinds: ['timelineItem'] });
  await f.renderReady({});
  const selected = await f.renderReady({ action: 'item:item-alice/project/1' });
  assert.ok(!nodes(selected).some(value => value.type === 'timelineItem'));
  const description = nodes(selected).find(value => value.id === 'issue-description');
  assert.equal(description.type, 'column');
  assert.equal(description.appearance, 'secondary');
  assert.ok(nodes(description).some(value => value.type === 'button' && value.text === 'alice'));
  assert.ok(nodes(description).some(value => value.type === 'markdown' && value.text === 'Description'));
});

test('Connecting GitHub has one main action and keeps the token form optional', async () => {
  const f = fixture();
  const initial = await f.renderReady({});
  assert.equal(initial.type, 'emptyState');
  assert.equal(nodes(initial).filter(value => value.appearance === 'primary').length, 1);
  assert.ok(!nodes(initial).some(value => value.type === 'secureField'));
  const token = await f.render({ action: 'toggle-token' });
  const form = nodes(token).find(value => value.id === 'github-token-form');
  assert.equal(form.appearance, 'secondary');
  assert.ok(nodes(form).some(value => value.type === 'secureField' && value.id === 'token'));
  assert.ok(nodes(form).some(value => value.action === 'connect-token'));
  assert.equal(f.writes.length, 0);
});

test('The device-code form groups verification and gives completion the main action', async () => {
  const f = fixture({ route: async url => {
    assert.equal(url.pathname, '/login/device/code');
    return body({ device_code: 'device_code', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
  } });
  const code = await f.render({ action: 'begin-login' });
  const group = nodes(code).find(value => value.id === 'github-device-code');
  assert.equal(group.appearance, 'secondary');
  assert.match(texts(group), /ABCD-1234/);
  assert.equal(nodes(code).find(value => value.appearance === 'primary').action, 'finish-login');
  assert.ok(nodes(code).some(value => value.action === 'open-login'));
  assert.ok(nodes(code).some(value => value.action === 'cancel-login'));
  assert.equal(f.writes.length, 0);
});

test('Opening another repository uses one bounded form and preserves invalid input for correction', async () => {
  const f = fixture({ saved: connection });
  await f.renderReady({});
  const formView = await f.render({ action: 'show-other-repo' });
  const form = nodes(formView).find(value => value.id === 'github-repository-form');
  assert.equal(form.appearance, 'secondary');
  assert.equal(nodes(form).find(value => value.appearance === 'primary').action, 'open-repo');
  const invalid = await f.render({ action: 'open-repo', values: { 'manual-repo': '../private' } });
  assert.equal(nodes(invalid).find(value => value.id === 'manual-repo').value, '../private');
  assert.ok(nodes(invalid).some(value => value.tone === 'danger'));
  assert.equal(f.writes.length, 0);
});
