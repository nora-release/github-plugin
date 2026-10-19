import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { botCommentBody } from './fixtures/bot-comment.js';

const pluginSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');
const factoryStart = pluginSource.indexOf('function createPullRequestView(');
const factoryEnd = pluginSource.indexOf('const panelID', factoryStart);
assert.ok(factoryStart >= 0 && factoryEnd > factoryStart);
const createView = vm.runInNewContext(`(${pluginSource.slice(factoryStart, factoryEnd).trim()})`);
const flatten = values => values.flatMap(value => [value, ...flatten(value.children || []), ...flatten(value.items || [])]);
const section = (items = []) => ({ items, loaded: true, loading: false, error: '', notice: '', nextPage: null });
const boundedText = (value, maximum, suffix = '') => {
  const text = String(value);
  if (Buffer.byteLength(text) <= maximum) return text;
  let result = '';
  for (const character of text) {
    if (Buffer.byteLength(result + character + suffix) > maximum) break;
    result += character;
  }
  return result + suffix;
};
const comment = (body = botCommentBody, user = { login: 'netlify[bot]', type: 'Bot' }, changes = {}) => ({
  id: 3, body, user, html_url: 'https://github.com/owner/repo/pull/1#issuecomment-3', created_at: '2026-10-16T00:00:00Z', ...changes,
});
const model = (source = 'comments', entry = comment()) => ({
  key: 'owner/repo/1', repo: 'owner/repo', number: 1, tab: 'discussion', headSHA: 'a'.repeat(40),
  item: { number: 1, state: 'open', body: 'Description', user: { login: 'author' } },
  sections: Object.fromEntries(['comments', 'reviews', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows', 'commits', 'files', 'repository'].map(name => [name, section(name === source ? [entry] : [])])),
  jobsByRun: {}, comment: { draft: '', fieldID: 'draft' }, merge: { pending: null },
});
const view = (properties = {}) => createView({
  node: (type, properties = {}, children = []) => ({ ...properties, type, children }),
  t: en => en, boundedText, displayedBody: value => value || 'No description.', short: (value, length = 512) => String(value ?? '').slice(0, length),
  itemStatus: () => ({ text: 'Open', tone: 'success' }), itemDate: value => String(value.updated_at || '').slice(0, 10),
  supportsNativeLayout: true, supportsNativeTimeline: true, ...properties,
});
const activity = (current, api = view()) => flatten(api.nativeContent(current)).filter(value => value.type === 'timelineItem' && value.id.startsWith('pr-activity-'));
const collapsed = card => flatten([card]).find(value => value.type === 'markdown' && value.text.startsWith('<details><summary>'));
const originalBody = markdown => markdown.text.slice('<details><summary>View full comment</summary>'.length, -'</details>'.length)
  .replace(/&(?:amp|lt|gt|#96|#126|#13|#10);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#96;': '`', '&#126;': '~', '&#13;': '\r', '&#10;': '\n' })[entity]);

test('Long bot notifications expose a source heading and preserve every original Markdown byte inside a closed disclosure', () => {
  const entry = comment(), authors = new WeakMap();
  const api = view({ avatarFor: () => 'known-avatar', onAuthorButton: (node, account, source) => authors.set(node, { account, source }) });
  const card = activity(model('comments', entry), api)[0];
  assert.equal(card.children[0].text, 'netlify[bot]');
  assert.equal(card.children[0].avatarBase64, 'known-avatar');
  assert.equal(authors.get(card.children[0]).source, entry);
  assert.equal(authors.get(card.children[0]).account, entry.user);
  const nodes = flatten([card]);
  assert.ok(nodes.some(value => value.type === 'markdown' && value.text === '✅ Deploy Preview for *vitest-dev* ready!'));
  assert.ok(!nodes.some(value => value.action === `pr-open:${encodeURIComponent(entry.html_url)}`), 'Comment cards do not repeat browser shortcuts');
  const disclosure = collapsed(card);
  assert.ok(disclosure);
  assert.equal(originalBody(disclosure), botCommentBody);
  assert.equal((disclosure.text.match(/<details>/g) || []).length, 1, 'User details tags must not open or close the outer native disclosure');
  assert.equal((disclosure.text.match(/<\/details>/g) || []).length, 1);
  assert.ok(!disclosure.text.includes(' open'));
  assert.ok(!disclosure.text.includes('```') && !disclosure.text.includes('~~~') && !disclosure.text.includes('\n'), 'The initial HTML pass must not extract or alter user code before decoding');
});

test('A long bot paragraph preserves its exact claim instead of inventing check success or failure', () => {
  const paragraph = 'The preview is waiting for approval by the repository administrator.';
  const card = activity(model('comments', comment(`${paragraph}\n\n${'Detailed original context. '.repeat(20)}`)))[0];
  const markdown = flatten([card]).filter(value => value.type === 'markdown');
  assert.equal(markdown[0].text, paragraph);
  assert.ok(!markdown[0].text.includes('passed'));
  assert.ok(collapsed(card));
});

test('Netlify inline span markup retains a readable summary without changing the original body', () => {
  const body = '### <span aria-hidden="true">✅</span> Deploy Preview for *vitest-dev* ready!\n\n' + botCommentBody;
  const card = activity(model('comments', comment(body)))[0];
  const markdown = flatten([card]).filter(value => value.type === 'markdown');
  assert.equal(markdown[0].text, '✅ Deploy Preview for *vitest-dev* ready!');
  assert.equal(originalBody(collapsed(card)), body);
  for (const unsafe of ['<script>not a heading</script>', '<spanx>not a heading</spanx>', '<span>name</span><details>hidden</details>']) {
    const rejected = activity(model('comments', comment(`${unsafe}\n\n${botCommentBody}`)))[0];
    assert.equal(flatten([rejected]).filter(value => value.type === 'markdown').length, 1);
  }
});

test('Bot identities require a GitHub Bot type or valid bot login rather than bot-like human names', () => {
  for (const user of [{ login: 'integration', type: 'Bot' }, { login: 'github-actions[bot]' }]) {
    assert.ok(collapsed(activity(model('comments', comment(botCommentBody, user)))[0]));
  }
  for (const user of [{ login: 'robot', type: 'User' }, { login: 'my-bot', type: 'User' }, { login: 'a human[bot]', type: 'User' }, { login: '[bot]', type: 'User' }]) {
    const card = activity(model('comments', comment(botCommentBody, user)))[0];
    assert.ok(!collapsed(card));
    assert.ok(flatten([card]).some(value => value.type === 'markdown' && value.text === botCommentBody));
  }
});

test('Reviews and inline review comments retain full content even from bot authors', () => {
  for (const source of ['reviews', 'reviewComments']) {
    const entry = comment(botCommentBody, undefined, { state: 'CHANGES_REQUESTED', path: 'src/main.ts', line: 42 });
    const card = activity(model(source, entry))[0];
    assert.deepEqual(Array.from(card.children[1].children, node => node.type), source === 'reviews'
      ? ['spacer', 'text', 'badge'] : ['spacer', 'text'], 'Dates and review states stay together at the trailing edge');
    assert.ok(!collapsed(card));
    assert.ok(flatten([card]).some(value => value.type === 'markdown' && value.text === botCommentBody));
    assert.ok(card.children[0].action?.startsWith('pr-open:'), 'The author profile remains available');
    assert.ok(!flatten([card]).some(value => value.action === `pr-open:${encodeURIComponent(entry.html_url)}`));
    if (source === 'reviews') assert.ok(flatten([card]).some(value => value.text === 'Changes requested'));
    else assert.ok(flatten([card]).some(value => value.text?.includes('src/main.ts') && value.text.includes('line 42')));
  }
});

test('Timeline-only bot comment fallbacks use the same disclosure while timeline reviews stay complete', () => {
  const card = activity(model('timeline', comment(botCommentBody, undefined, { event: 'commented' })))[0];
  assert.equal(originalBody(collapsed(card)), botCommentBody);
  const review = activity(model('timeline', comment(botCommentBody, undefined, { event: 'reviewed', state: 'APPROVED' })))[0];
  assert.ok(!collapsed(review));
  assert.ok(flatten([review]).some(value => value.type === 'markdown' && value.text === botCommentBody));
});

test('Short ordinary bot text stays readable, while short tables and code remain collapsible', () => {
  const short = 'The preview is waiting for approval.';
  assert.ok(!collapsed(activity(model('comments', comment(short)))[0]));
  for (const body of ['Name | Link\n--- | ---\na | b', '| Name | Link |\n| --- | --- |\n| a | b |', '```sh\nexit 1\n```', '    exit 1', '<details><summary>More</summary>body</details>']) {
    const card = activity(model('comments', comment(body)))[0];
    assert.equal(originalBody(collapsed(card)), body);
    assert.equal(flatten([card]).filter(value => value.type === 'markdown').length, 1, 'Nonprose blocks cannot become a fabricated summary');
  }
});

test('Empty comments, unhelpful summaries, and older hosts retain safe complete content and links', () => {
  const empty = activity(model('comments', comment('')))[0];
  assert.ok(!flatten([empty]).some(value => value.type === 'markdown'));
  const noSummary = `![logo](https://example.com/logo.png)\n\n${'Context. '.repeat(50)}`;
  const card = activity(model('comments', comment(noSummary)))[0];
  assert.equal(flatten([card]).filter(value => value.type === 'markdown').length, 1);
  assert.equal(originalBody(collapsed(card)), noSummary);
  const legacy = flatten(view({ supportsNativeTimeline: false }).nativeContent(model()));
  assert.ok(!legacy.some(value => value.type === 'timelineItem'));
  assert.ok(legacy.some(value => value.type === 'markdown' && value.text === botCommentBody));
  assert.ok(!legacy.some(value => value.action === `pr-open:${encodeURIComponent(comment().html_url)}`));
});

test('Disclosures retain bodies larger than the former 6 KiB preview and preserve CRLF and entities exactly', () => {
  const body = '## Original title\r\n\r\n' + '🙂 &amp; <tag> `x < 2`\r\n'.repeat(300);
  assert.ok(Buffer.byteLength(body) > 6 * 1024);
  const card = activity(model('comments', comment(body)))[0];
  assert.equal(originalBody(collapsed(card)), body);
  assert.ok(Buffer.byteLength(collapsed(card).text) <= 64 * 1024);
});

test('Oversized bot content remains exact across native text pages without truncated disclosures or forced website fallback', () => {
  const tooLarge = '## Original title\r\n\r\n' + '<&`~>🙂汉\r\n'.repeat(10000);
  const current = model('comments', comment(tooLarge)), api = view(), parts = [];
  current.comment.draft = 'An unfinished reply.';
  let firstCard, lastCard, steps = 0;
  while (true) {
    assert.ok(++steps <= 100, 'Native text paging must terminate');
    const content = api.nativeContent(current), card = activity(current, api)[0], nodes = flatten([card]);
    firstCard ||= card; lastCard = card;
    const disclosure = collapsed(card);
    if (disclosure) {
      assert.ok(disclosure.text.endsWith('</details>'));
      parts.push(originalBody(disclosure));
    } else {
      const markdown = nodes.filter(value => value.type === 'markdown');
      assert.equal(markdown.length, 1);
      parts.push(markdown[0].text);
    }
    assert.ok(!nodes.some(value => /Content shortened|View complete history/.test(value.text || '')));
    assert.ok(card.children[0].action?.startsWith('pr-open:'), 'The author profile stays available');
    assert.ok(flatten(content).some(value => value.type === 'textEditor' && value.value === current.comment.draft));
    assert.ok(flatten(content).length <= 200);
    assert.ok(Buffer.byteLength(JSON.stringify(content)) <= 185 * 1024);
    const next = nodes.find(value => /^pr-body:[a-f\d]{16}:next$/.test(value.action || '') && !value.disabled);
    if (!next) break;
    assert.ok(api.navigateBody(current, next.action.split(':')[1], 'next'));
  }
  assert.ok(steps > 1);
  assert.equal(parts.join(''), tooLarge, 'Unicode, CRLF, entities and code markers retain every original byte');
  assert.equal(lastCard.id, firstCard.id, 'Moving through body pages keeps the comment identity stable');
  const previous = flatten([lastCard]).find(value => /^pr-body:[a-f\d]{16}:prev$/.test(value.action || '') && !value.disabled);
  assert.ok(previous);
  assert.ok(api.navigateBody(current, previous.action.split(':')[1], 'prev'));
});

test('All loaded bot notifications remain reachable through native history pages with complete disclosure wrappers', () => {
  const current = model(), api = view(), visited = new Set();
  current.sections.comments = section(Array.from({ length: 70 }, (_, index) => comment(`## Notification ${index}\n\n${'Detail. '.repeat(1000)}`, undefined, { id: index })));
  let pages = 0;
  while (true) {
    assert.ok(++pages <= 70, 'Native history pages must terminate');
    const content = api.nativeContent(current), nodes = flatten(content);
    assert.ok(nodes.length <= 200);
    assert.ok(Buffer.byteLength(JSON.stringify(content)) <= 185 * 1024);
    assert.ok(!nodes.some(value => value.text === 'View complete history'));
    for (const value of nodes.filter(value => value.type === 'markdown' && value.text.startsWith('<details>'))) {
      assert.ok(value.text.endsWith('</details>'));
      const original = originalBody(value), match = /^## Notification (\d+)\n/.exec(original);
      assert.ok(match);
      assert.equal(original, current.sections.comments.items[Number(match[1])].body);
      visited.add(Number(match[1]));
    }
    if (!nodes.some(value => value.action === 'pr-discussion-next' && !value.disabled)) break;
    assert.ok(api.navigateDiscussion(current, 'next'));
  }
  assert.ok(pages > 1);
  assert.deepEqual([...visited].sort((left, right) => left - right), Array.from({ length: 70 }, (_, index) => index));
});
