/// <reference types="@nora/plugin-kit" />
(() => {
  'use strict';
  const panelID = 'com.nora.github.panel';
  const clientID = 'Iv23liPZy7EARoSnYoYy';
  const connectionKey = 'connection';
  const isChinese = /^zh/i.test(nora.locale || '');
  const t = (en, zh) => isChinese ? zh : en;
  const message = {
    connect: t('Connect GitHub', '连接 GitHub'),
    signIn: t('Continue with GitHub', '使用 GitHub 登录'),
    manage: t('Manage repository access', '管理仓库访问权限'),
    account: t('Choose repositories in your own account or organization on GitHub.', '在 GitHub 中选择你自己的账号或组织中的仓库。'),
    refresh: t('Refresh', '刷新'),
    repos: t('Choose a repository', '选择仓库'),
    more: t('Load more', '加载更多'),
    noItems: t('No matching items.', '暂无符合条件的条目。'),
    noRepos: t('No repositories yet. Manage repository access, then refresh.', '暂无可用仓库，请选择仓库访问范围后刷新。'),
    expired: t('Your GitHub connection expired. Connect again.', 'GitHub 登录已过期，请重新连接。'),
    denied: t('GitHub access was denied. Check the selected repositories and organization approval.', 'GitHub 访问被拒绝，请检查已选择的仓库和组织授权。'),
    network: t('GitHub could not be reached. Try again.', '无法连接 GitHub，请重试。'),
    invalid: t('GitHub returned an invalid response. Try again.', 'GitHub 返回了无效结果，请重试。'),
  };
  const state = { user: null, repos: [], repo: '', items: [], kind: 'issues', status: 'open', query: '', page: 1, repoPage: 1, moreItems: false, moreRepos: false, selected: null, device: null, error: '', restored: false };
  let generation = 0;
  let itemRevision = 0;
  let repoRevision = 0;
  let refreshOperation = null;
  let credentialWrites = Promise.resolve();
  let renderRevision = 0;
  const node = (type, properties = {}, children = []) => nora.ui.node(type, properties, children);
  const text = value => nora.ui.text(String(value));
  const button = (label, action, disabled = false) => node('button', { text: label, action, disabled });
  const column = children => node('column', {}, children);
  const row = children => node('row', {}, children);
  const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,4096}$/.test(value);
  const readSaved = async () => {
    const value = await nora.request('credentials.get', { key: connectionKey });
    let saved;
    try { saved = typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
    if (!saved || !validToken(saved.token)) return null;
    const validDate = value => value === undefined || value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (!validDate(saved.expiresAt) || !validDate(saved.refreshExpiresAt) ||
        saved.refreshToken !== undefined && saved.refreshToken !== null && !validToken(saved.refreshToken)) return null;
    return saved;
  };
  const save = saved => nora.request('credentials.set', { key: connectionKey, value: JSON.stringify(saved) });
  const updateCredentials = operation => {
    const next = credentialWrites.then(operation);
    credentialWrites = next.catch(() => {});
    return next;
  };
  const saveForGeneration = (saved, current) => updateCredentials(async () => {
    if (current !== generation) return false;
    await save(saved);
    return current === generation;
  });
  const connectionChanged = () => new Error(t('The GitHub connection changed. Try again.', 'GitHub 连接已更改，请重试。'));
  const form = fields => Object.entries(fields).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  async function http(url, { method = 'GET', headers = {}, body } = {}) {
    let response;
    try { response = await nora.request('network.request', { url, method, headers, ...(body === undefined ? {} : { body }) }); }
    catch { throw new Error(message.network); }
    if (!response || !Number.isInteger(response.status)) throw new Error(message.invalid);
    return response;
  }
  function json(response) {
    try { return JSON.parse(response.bodyText); } catch { throw new Error(message.invalid); }
  }
  async function auth(fields, path = '/login/oauth/access_token') {
    const response = await http(`https://github.com${path}`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(fields) });
    if (response.status !== 200) throw new Error(message.network);
    return json(response);
  }
  function credentials(result) {
    if (!validToken(result.access_token) || String(result.token_type).toLowerCase() !== 'bearer') throw new Error(message.invalid);
    const expiration = seconds => {
      if (seconds === undefined) return null;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 63072000) throw new Error(message.invalid);
      return Date.now() + seconds * 1000;
    };
    if (result.refresh_token !== undefined && !validToken(result.refresh_token)) throw new Error(message.invalid);
    if ((result.refresh_token === undefined) !== (result.refresh_token_expires_in === undefined)) throw new Error(message.invalid);
    return { token: result.access_token, expiresAt: expiration(result.expires_in), refreshToken: result.refresh_token || null, refreshExpiresAt: expiration(result.refresh_token_expires_in) };
  }
  async function activeCredentials() {
    const saved = await readSaved();
    if (!saved) throw new Error(message.expired);
    if (!saved.expiresAt || saved.expiresAt > Date.now() + 60000) return saved;
    if (!saved.refreshToken || (saved.refreshExpiresAt && saved.refreshExpiresAt <= Date.now())) throw new Error(message.expired);
    if (refreshOperation && (refreshOperation.token !== saved.token || refreshOperation.refreshToken !== saved.refreshToken)) {
      await refreshOperation.promise.catch(() => {});
      return activeCredentials();
    }
    if (!refreshOperation) {
      const operation = { token: saved.token, refreshToken: saved.refreshToken, promise: null };
      operation.promise = (async () => {
        const result = await auth({ client_id: clientID, grant_type: 'refresh_token', refresh_token: saved.refreshToken });
        if (result.error) throw new Error(message.expired);
        const refreshed = credentials(result);
        const didSave = await updateCredentials(async () => {
          const latest = await readSaved();
          if (latest?.token !== saved.token || latest?.refreshToken !== saved.refreshToken) return false;
          await save(refreshed);
          return true;
        });
        if (!didSave) throw connectionChanged();
        return refreshed;
      })().finally(() => { if (refreshOperation === operation) refreshOperation = null; });
      refreshOperation = operation;
    }
    return refreshOperation.promise;
  }
  async function api(path, token) {
    const current = generation;
    const connection = token ? { token } : await activeCredentials();
    if (current !== generation) throw connectionChanged();
    const response = await http(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${connection.token}`, 'X-GitHub-Api-Version': '2026-03-10' } });
    if (current !== generation) throw connectionChanged();
    if (response.status === 401) throw new Error(message.expired);
    if (response.status === 429 || response.status === 403 && (response.headers?.['x-ratelimit-remaining'] === '0' || response.headers?.['retry-after'])) throw new Error(t('GitHub rate limit reached. Try again later.', 'GitHub 请求次数已达上限，请稍后重试。'));
    if (response.status === 403) throw new Error(message.denied);
    if (response.status === 404) throw new Error(t('Repository not found or not authorized.', '找不到仓库或尚未授权。'));
    if (response.status !== 200) throw new Error(message.network);
    return { data: json(response), headers: response.headers || {} };
  }
  function repository(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error(t('Enter a repository as owner/name.', '请输入 owner/name 格式的仓库。'));
    return value;
  }
  function page(value = 1) {
    if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error(t('Invalid page.', '页码无效。'));
    return value;
  }
  function status(value = 'open') {
    if (!['open', 'closed', 'all'].includes(value)) throw new Error(t('Invalid state.', '状态无效。'));
    return value;
  }
  const hasNext = headers => /rel="next"/.test(headers.link || headers.Link || '');
  const deduplicate = items => [...new Map(items.map(item => [item.id, item])).values()];
  async function listRepositories(args = {}) {
    const p = page(args.page);
    const result = await api(`/user/repos?sort=updated&per_page=50&page=${p}`);
    if (!Array.isArray(result.data)) throw new Error(message.invalid);
    return { items: result.data, nextPage: hasNext(result.headers) ? p + 1 : null };
  }
  async function listItems(args, kind) {
    const repo = repository(args.repository), p = page(args.page), filter = status(args.state);
    const result = await api(`/repos/${repo}/${kind}?state=${filter}&sort=updated&direction=desc&per_page=50&page=${p}`);
    if (!Array.isArray(result.data)) throw new Error(message.invalid);
    return { items: kind === 'issues' ? result.data.filter(item => !item.pull_request) : result.data, nextPage: hasNext(result.headers) ? p + 1 : null };
  }
  async function loadItems(append = false) {
    const revision = ++itemRevision, current = generation;
    const requestedRepo = state.repo, requestedKind = state.kind, requestedStatus = state.status;
    if (!requestedRepo) { state.items = []; state.selected = null; return; }
    const requestedPage = append ? state.page + 1 : 1;
    if (!append) { state.items = []; state.selected = null; state.moreItems = false; }
    const result = await listItems({ repository: requestedRepo, state: requestedStatus, page: requestedPage }, requestedKind);
    if (current !== generation || revision !== itemRevision) return;
    state.page = requestedPage;
    state.items = deduplicate(append ? [...state.items, ...result.items] : result.items);
    state.moreItems = !!result.nextPage;
    if (!append) state.selected = null;
  }
  async function loadRepositories(append = false) {
    const revision = ++repoRevision, current = generation;
    const requestedPage = append ? state.repoPage + 1 : 1;
    const result = await listRepositories({ page: requestedPage });
    if (current !== generation || revision !== repoRevision) return;
    state.repoPage = requestedPage;
    state.repos = deduplicate(append ? [...state.repos, ...result.items] : result.items);
    state.moreRepos = !!result.nextPage;
    if (!state.repo && state.repos.length) { state.repo = state.repos[0].full_name; await loadItems(); }
  }
  function clearAccount() {
    state.user = null; state.repos = []; state.repo = ''; state.items = []; state.selected = null; state.device = null;
    state.moreItems = false; state.moreRepos = false;
    state.page = 1; state.repoPage = 1; state.query = '';
    ++itemRevision; ++repoRevision;
  }
  async function restore() {
    if (state.restored) return;
    state.restored = true;
    const current = generation;
    if (!await readSaved()) return;
    const result = await api('/user');
    if (current !== generation) return;
    if (!result.data || typeof result.data.login !== 'string' || !result.data.login) throw new Error(message.invalid);
    state.user = result.data;
    await loadRepositories();
  }
  async function beginLogin() {
    const current = ++generation;
    state.device = null;
    const result = await auth({ client_id: clientID }, '/login/device/code');
    if (current !== generation) return;
    if (result.error || !/^[A-Za-z0-9_-]{1,256}$/.test(result.device_code || '') || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(result.user_code || '') || result.verification_uri !== 'https://github.com/login/device' || !Number.isInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 86400 || !Number.isInteger(result.interval) || result.interval < 1 || result.interval > 3600) throw new Error(message.invalid);
    state.device = { deviceCode: result.device_code, userCode: result.user_code, expiresAt: Date.now() + result.expires_in * 1000, nextPoll: Date.now() + result.interval * 1000, interval: result.interval };
  }
  async function finishLogin() {
    const device = state.device;
    if (!device || Date.now() >= device.expiresAt) { state.device = null; throw new Error(t('Authorization code expired. Start again.', '授权验证码已过期，请重新登录。')); }
    if (Date.now() < device.nextPoll) throw new Error(t('Confirm on GitHub, then try again in a few seconds.', '请在 GitHub 确认，稍等几秒后重试。'));
    const current = generation;
    device.nextPoll = Date.now() + device.interval * 1000;
    const result = await auth({ client_id: clientID, device_code: device.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (current !== generation || state.device !== device) return;
    if (result.error === 'authorization_pending') throw new Error(t('Waiting for your confirmation on GitHub.', '等待你在 GitHub 确认授权。'));
    if (result.error === 'slow_down') {
      if (result.interval !== undefined && (!Number.isInteger(result.interval) || result.interval < 1 || result.interval > 3600)) throw new Error(message.invalid);
      device.interval = Math.max(device.interval + 5, result.interval || 0);
      device.nextPoll = Date.now() + device.interval * 1000;
      throw new Error(t('GitHub requested a longer wait. Try again shortly.', 'GitHub 要求稍后重试，请等待几秒。'));
    }
    if (result.error) { state.device = null; throw new Error(message.expired); }
    const saved = credentials(result), user = (await api('/user', saved.token)).data;
    if (current !== generation || state.device !== device) return;
    if (!user || typeof user.login !== 'string' || !user.login) throw new Error(message.invalid);
    if (!await saveForGeneration(saved, current) || state.device !== device) return;
    clearAccount(); state.user = user; state.restored = true;
    await loadRepositories();
  }
  async function connectToken(value) {
    if (!validToken(value)) throw new Error(t('Enter a valid GitHub access token.', '请输入有效的 GitHub 访问 token。'));
    const current = ++generation;
    state.device = null;
    const user = (await api('/user', value)).data;
    if (current !== generation) return;
    if (!user || typeof user.login !== 'string' || !user.login) throw new Error(message.invalid);
    if (!await saveForGeneration({ token: value }, current)) return;
    clearAccount(); state.user = user; state.restored = true;
    await loadRepositories();
  }
  function itemText(item) {
    const author = item.user?.login || 'ghost';
    const statusText = item.merged_at ? t('Merged', '已合并') : item.draft ? t('Draft', '草稿') : item.state === 'closed' ? t('Closed', '已关闭') : t('Open', '打开');
    return `#${item.number}  ${item.title}\n${author} · ${statusText}`;
  }
  function displayedBody(value) {
    if (typeof value !== 'string' || !value) return t('No description.', '暂无描述。');
    let bytes = 0;
    const characters = [];
    for (const character of value) {
      const code = character.codePointAt(0);
      const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (bytes + size > 63 * 1024) {
        return characters.join('') + '\n\n' + t('Description shortened. View on GitHub for the full text.', '描述过长已截断，点击“在 GitHub 查看”阅读完整内容。');
      }
      characters.push(character);
      bytes += size;
    }
    return value;
  }
  function view() {
    const children = [row([text('GitHub'), node('spacer'), ...(state.user ? [text(state.user.login), button(t('Disconnect', '断开连接'), 'disconnect')] : [])])];
    if (state.error) children.push(text(state.error));
    if (!state.user) {
      children.push(text(t('Connect your account to view repositories, issues, and pull requests.', '连接你自己的账号，查看仓库、Issues 和 PR。')), button(message.manage, 'manage'), text(message.account));
      if (state.device) children.push(text(t('Enter this code on GitHub:', '在 GitHub 输入此验证码：')), text(state.device.userCode), row([button(t('Open GitHub', '打开 GitHub'), 'open-login'), button(t('Finish sign-in', '完成登录'), 'finish-login'), button(t('Cancel', '取消'), 'cancel-login')]), text(t('Confirm authorization in your browser, then choose Finish sign-in.', '在浏览器确认授权后，点击“完成登录”。')));
      else children.push(button(message.signIn, 'begin-login'), node('secureField', { id: 'token', placeholder: t('Optional: access token', '可选：使用访问 token') }), button(t('Connect with token', '使用 token 连接'), 'connect-token'));
      children.push(text(t('Credentials stay in your Mac’s Keychain.', '账号凭据保存在你电脑的 Keychain 中。')));
      return column(children);
    }
    children.push(row([node('picker', { id: 'repository', text: message.repos, action: 'repository', value: state.repo, options: state.repos.map(repo => ({ value: repo.full_name, text: `${repo.full_name}${repo.private ? ' 🔒' : ''}` })) }), button(message.refresh, 'refresh'), button(message.manage, 'manage')]));
    if (state.moreRepos) children.push(button(t('More repositories', '更多仓库'), 'more-repos'));
    if (!state.repos.length) children.push(text(message.noRepos));
    children.push(row([node('textField', { id: 'manual-repo', placeholder: 'owner/name', value: state.repo }), button(t('Open repository', '打开仓库'), 'open-repo')]));
    children.push(row([node('picker', { id: 'kind', action: 'kind', value: state.kind, options: [{ value: 'issues', text: 'Issues' }, { value: 'pulls', text: 'PR' }] }), node('picker', { id: 'status', action: 'status', value: state.status, options: [{ value: 'open', text: t('Open', '打开') }, { value: 'closed', text: t('Closed', '已关闭') }, { value: 'all', text: t('All', '全部') }] }), node('textField', { id: 'query', action: 'query', placeholder: t('Filter loaded items', '筛选已加载的条目'), value: state.query })]));
    const query = state.query.toLowerCase();
    const items = state.items.filter(item => `${item.number} ${item.title} ${item.user?.login || ''}`.toLowerCase().includes(query));
    children.push(node('list', { items: items.map(item => node('button', { id: `item-${item.number}`, text: itemText(item), action: `item:${item.number}` })) }));
    if (!items.length) children.push(text(message.noItems));
    if (state.moreItems) children.push(button(message.more, 'more-items'));
    if (state.selected) children.push(node('divider'), text(itemText(state.selected)), text(displayedBody(state.selected.body)), button(t('View on GitHub', '在 GitHub 查看'), 'open-item'));
    return column(children);
  }
  const web = async url => {
    if (typeof url !== 'string' || !/^https:\/\/github\.com\/(?!\/)/.test(url) || /[\s\\]/.test(url)) throw new Error(message.invalid);
    return nora.request('browser.open', { url });
  };
  nora.registerPanel(panelID, async (event = {}) => {
    const revision = ++renderRevision;
    state.error = '';
    const values = event.values || {};
    try {
      const action = event.action;
      if (action !== 'disconnect' && action !== 'cancel-login') await restore();
      if (action === 'disconnect' || action === 'cancel-login') {
        ++generation; clearAccount(); state.restored = true;
        if (action === 'disconnect') {
          await updateCredentials(() => nora.request('credentials.delete', { key: connectionKey }));
        }
      } else if (action === 'manage') await web('https://github.com/apps/nora-github-plugin/installations/new');
      else if (action === 'begin-login') await beginLogin();
      else if (action === 'open-login') await web('https://github.com/login/device');
      else if (action === 'finish-login') await finishLogin();
      else if (action === 'connect-token') await connectToken(values.token || '');
      else if (action === 'refresh') { await loadRepositories(); if (state.repo) await loadItems(); }
      else if (action === 'more-repos') await loadRepositories(true);
      else if (action === 'more-items') await loadItems(true);
      else if (action === 'open-repo' || action === 'repository') { state.repo = repository(action === 'open-repo' ? values['manual-repo'] : (event.value ?? values.repository)); await loadItems(); }
      else if (action === 'kind') { state.kind = event.value ?? values.kind; if (!['issues', 'pulls'].includes(state.kind)) state.kind = 'issues'; await loadItems(); }
      else if (action === 'status') { state.status = status(event.value ?? values.status); await loadItems(); }
      else if (action === 'query') state.query = event.value ?? values.query ?? '';
      else if (action?.startsWith('item:')) state.selected = state.items.find(item => item.number === Number(action.slice(5))) || null;
      else if (action === 'open-item' && state.selected) await web(state.selected.html_url);
    } catch (error) { if (revision === renderRevision) state.error = error?.message || message.network; }
    return view();
  });
  nora.registerCommand('com.nora.github.listRepositories', listRepositories);
  nora.registerCommand('com.nora.github.listIssues', args => listItems(args, 'issues'));
  nora.registerCommand('com.nora.github.listPullRequests', args => listItems(args, 'pulls'));
})();
