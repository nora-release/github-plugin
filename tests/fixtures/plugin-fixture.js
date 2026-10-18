import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const plugin = await fs.readFile(new URL('../../plugin.js', import.meta.url), 'utf8');
const sdkPath = process.env.NORA_PLUGIN_KIT_PATH
  ? `${process.env.NORA_PLUGIN_KIT_PATH}/Sources/NoraPluginKit/Resources/script-api.js`
  : new URL('../../node_modules/@nora/plugin-kit/Sources/NoraPluginKit/Resources/script-api.js', import.meta.url);
const sdk = (await fs.readFile(sdkPath, 'utf8')).replace('export default function', 'function');
const body = (data, status = 200, headers = {}) => ({ status, headers, bodyText: JSON.stringify(data) });
const searchBody = (items, status = 200, headers = {}, extra = {}) => body({ items, total_count: items.length, incomplete_results: false, ...extra }, status, headers);
const repo = (name = 'alice/project', id = 1) => ({ id, full_name: name, private: true });
const issue = (number, title, extra = {}) => ({ id: number, number, title, body: 'Description', state: 'open', user: { login: 'alice' }, html_url: `https://github.com/alice/project/issues/${number}`, repository_url: 'https://api.github.com/repos/alice/project', ...extra });
const nodes = view => [view, ...(view.children || []).flatMap(nodes), ...(view.items || []).flatMap(nodes)];
const texts = view => nodes(view).flatMap(node => [node.text, node.subtitle].filter(Boolean)).join('\n');
function fixture({ saved = null, locale = 'en', unavailableViewKinds = [], supportsPanelInvalidation = true, supportsDetailAside = false, supportsItemRowIcon = false, supportsFileIcons = false, supportsPurpleTone = false, supportsButtonIcon = false, supportsTabBarSummary = false, supportsContinuousContent = false, now = () => Date.now(), beforeRead = async () => {}, beforeSave = async () => {}, onInvalidate = () => true, ownerAvatarRoute = null, route = async url => {
  if (url.pathname === '/user') return body({ login: 'alice' });
  if (url.pathname === '/user/repos') return body([repo()]);
  if (url.pathname === '/search/issues') {
    const query = url.searchParams.get('q') || '';
    const repository = /(?:^| )repo:([^ ]+)/.exec(query)?.[1] || 'alice/project';
    const isPull = query.includes('is:pull-request');
    const candidates = [issue(1, 'Issue one', {
      repository_url: `https://api.github.com/repos/${repository}`,
      html_url: `https://github.com/${repository}/issues/1`,
    }), issue(1, 'Pull request one', {
      repository_url: `https://api.github.com/repos/${repository}`,
      html_url: `https://github.com/${repository}/pull/1`, pull_request: {},
    })];
    const items = candidates.filter(value => Boolean(value.pull_request) === isPull);
    return searchBody(items);
  }
  const scoped = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)(?:\/([1-9][0-9]*))?$/.exec(url.pathname);
  if (scoped) {
    const item = issue(scoped[3] ? Number(scoped[3]) : 1, 'Issue one', {
      repository_url: `https://api.github.com/repos/${scoped[1]}`,
      html_url: `https://github.com/${scoped[1]}/${scoped[2] === 'pulls' ? 'pull' : 'issues'}/${scoped[3] || 1}`,
    });
    return body(scoped[3] ? item : [item]);
  }
  return body([issue(1, 'Issue one')]);
} } = {}) {
  let stored = saved;
  const actionCapabilities = new Set();
  const requests = [], writes = [], links = [], drafts = [], invalidations = [], transfers = [];
  let invalidationWaiters = [];
  const request = async (method, args) => {
    if (method === 'credentials.get') { await beforeRead(); return stored; }
    if (method === 'credentials.set') { await beforeSave(args.value); stored = args.value; writes.push(stored); return null; }
    if (method === 'credentials.delete') { stored = null; return null; }
    if (method === 'browser.open') { links.push(args.url); return true; }
    if (method === 'panels.invalidate') {
      invalidations.push(args);
      invalidationWaiters = invalidationWaiters.filter(waiter => {
        if (invalidations.length <= waiter.after) return true;
        waiter.resolve(); return false;
      });
      return await onInvalidate(args);
    }
    if (method === 'chat.openDraft') {
      if (!actionCapabilities.has(args.actionCapability)) throw new Error('The draft action scope expired.');
      const { actionCapability, ...draft } = args;
      drafts.push(draft);
      return true;
    }
    if (method === 'network.request') {
      requests.push(args);
      const url = new URL(args.url);
      if (url.hostname === 'avatars.githubusercontent.com' && args.maximumResponseBytes === 8 * 1024) {
        return ownerAvatarRoute ? ownerAvatarRoute(url, args) : body({}, 404);
      }
      return route(url, args);
    }
    throw new Error(`Unexpected method: ${method}`);
  };
  class ClockDate extends Date { static now() { return now(); } }
  const context = vm.createContext({ request, locale, Date: ClockDate, unavailableViewKinds, supportsDetailAside, supportsItemRowIcon, supportsFileIcons, supportsPurpleTone, supportsButtonIcon, supportsTabBarSummary, supportsContinuousContent });
  const hostSDK = sdk.replace('Object.fromEntries(kinds.map(type =>', 'Object.fromEntries(kinds.filter(type => !unavailableViewKinds.includes(type)).map(type =>')
    .replace('panels: Object.freeze(', supportsPanelInvalidation ? 'panels: Object.freeze(' : 'unavailablePanels: Object.freeze(')
    .replace('detailAside: true', 'detailAside: supportsDetailAside')
    .replace('itemRowIcon: true', 'itemRowIcon: supportsItemRowIcon')
    .replace('fileIcons: true', 'fileIcons: supportsFileIcons')
    .replace('purpleTone: true', 'purpleTone: supportsPurpleTone')
    .replace('buttonIcon: true', 'buttonIcon: supportsButtonIcon')
    .replace('tabBarSummary: true', 'tabBarSummary: supportsTabBarSummary')
    .replace('continuousContent: true', 'continuousContent: supportsContinuousContent');
  vm.runInContext(`${hostSDK}\nglobalThis.api = createNoraPluginAPI(request, locale);\n${plugin}`, context);
  const hydrate = async result => {
    const descriptor = result.noraViewDocument;
    if (!descriptor) return result;
    const pieces = [];
    for (let index = 0; index < descriptor.chunkCount; index++) {
      const reply = await context.api.invokePanel('com.nora.github.panel', { contentTransfer: { token: descriptor.token, index } });
      const chunk = reply.noraViewChunk;
      if (!chunk || chunk.token !== descriptor.token || chunk.index !== index || typeof chunk.text !== 'string') throw new Error('Invalid native content transfer.');
      pieces.push(chunk.text);
    }
    const document = pieces.join('');
    if (Buffer.byteLength(document) !== descriptor.byteCount) throw new Error('Native content transfer was incomplete.');
    transfers.push({ chunkCount: descriptor.chunkCount, byteCount: descriptor.byteCount });
    return JSON.parse(document);
  };
  const render = async (event = {}) => {
    const actionCapability = typeof event.action === 'string' && event.action.trim() ? randomUUID() : undefined;
    if (actionCapability) actionCapabilities.add(actionCapability);
    try {
      return await hydrate(await context.api.invokePanel('com.nora.github.panel', { ...event, actionCapability }));
    } finally {
      if (actionCapability) actionCapabilities.delete(actionCapability);
    }
  };
  const waitForInvalidation = (after = invalidations.length) => invalidations.length > after ? Promise.resolve()
    : new Promise(resolve => invalidationWaiters.push({ after, resolve }));
  const renderReady = async (event = {}) => {
    let after = invalidations.length, result = await render(event);
    while (result.id === 'github-restoring') {
      await waitForInvalidation(after);
      after = invalidations.length;
      result = await render({});
    }
    return result;
  };
  return {
    render, renderReady, waitForInvalidation,
    renderUnscoped: event => context.api.invokePanel('com.nora.github.panel', event),
    requestDraft: (draft, event) => context.nora.chat.openDraft(draft, event),
    command: (id, args = {}) => context.api.invokeCommand(`com.nora.github.${id}`, args),
    requests, writes, links, drafts, invalidations, transfers, stored: () => stored,
  };
}
const connection = { token: 'test_token' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export { fixture, body, searchBody, repo, issue, nodes, texts, connection, deferred };
