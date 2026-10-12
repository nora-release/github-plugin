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
    noRepos: t('Choose repositories in GitHub, then refresh to start browsing.', '在 GitHub 选择可访问的仓库，刷新后即可浏览。'),
    expired: t('Your GitHub connection expired. Connect again.', 'GitHub 登录已过期，请重新连接。'),
    denied: t('GitHub access was denied. Check the selected repositories and organization approval.', 'GitHub 访问被拒绝，请检查已选择的仓库和组织授权。'),
    network: t('GitHub could not be reached. Try again.', '无法连接 GitHub，请重试。'),
    invalid: t('GitHub returned an invalid response. Try again.', 'GitHub 返回了无效结果，请重试。'),
  };
  const state = { user: null, repos: [], repo: '', repoQuery: '', items: [], kind: 'issues', status: 'open', query: '', author: '', label: '', page: 1, repoPage: 1, moreItems: false, moreRepos: false, selected: null, detailsVisible: false, device: null, error: '', restored: false, showToken: false, showOtherRepository: false, manualRepository: '', itemsLoading: false, reposLoading: false };
  let generation = 0;
  let itemRevision = 0;
  let repoRevision = 0;
  let refreshOperation = null;
  let credentialWrites = Promise.resolve();
  let renderRevision = 0;
  const node = (type, properties = {}, children = []) => nora.ui.node(type, properties, children);
  const button = (label, action, disabled = false, properties = {}) => node('button', { text: label, action, disabled, ...properties });
  const column = children => node('column', {}, children);
  const row = children => node('row', {}, children);
  const styledText = (value, textStyle = 'caption', tone = 'muted') => node('text', { text: String(value), textStyle, tone });
  const menu = (label, children, symbol) => node('menu', { text: label, ...(symbol ? { symbol } : {}) }, children);
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
    if (!requestedRepo) { state.items = []; state.selected = null; state.detailsVisible = false; return; }
    const requestedPage = append ? state.page + 1 : 1;
    if (!append) { state.items = []; state.selected = null; state.detailsVisible = false; state.moreItems = false; }
    state.itemsLoading = true;
    try {
      const result = await listItems({ repository: requestedRepo, state: requestedStatus, page: requestedPage }, requestedKind);
      if (current !== generation || revision !== itemRevision) return;
      state.page = requestedPage;
      state.items = deduplicate(append ? [...state.items, ...result.items] : result.items);
      state.moreItems = !!result.nextPage;
      if (state.selected) state.selected = state.items.find(item => item.id === state.selected.id) || null;
    } catch (error) {
      if (current !== generation || revision !== itemRevision) return;
      state.error = error?.message || message.network;
      throw error;
    } finally {
      if (current === generation && revision === itemRevision) state.itemsLoading = false;
    }
  }
  async function loadRepositories(append = false) {
    const revision = ++repoRevision, current = generation;
    const requestedPage = append ? state.repoPage + 1 : 1;
    state.reposLoading = true;
    try {
      const result = await listRepositories({ page: requestedPage });
      if (current !== generation || revision !== repoRevision) return false;
      state.repoPage = requestedPage;
      state.repos = deduplicate(append ? [...state.repos, ...result.items] : result.items);
      state.moreRepos = !!result.nextPage;
      if (!state.repo && state.repos.length) { state.repo = state.repos[0].full_name; await loadItems(); }
      return current === generation && revision === repoRevision;
    } catch (error) {
      if (current !== generation || revision !== repoRevision) return false;
      state.error = error?.message || message.network;
      throw error;
    } finally {
      if (current === generation && revision === repoRevision) state.reposLoading = false;
    }
  }
  function clearAccount() {
    state.user = null; state.repos = []; state.repo = ''; state.items = []; state.selected = null; state.device = null;
    state.moreItems = false; state.moreRepos = false;
    state.page = 1; state.repoPage = 1; state.query = ''; state.repoQuery = ''; state.author = ''; state.label = ''; state.kind = 'issues'; state.status = 'open';
    state.detailsVisible = false; state.showToken = false; state.showOtherRepository = false;
    state.manualRepository = ''; state.itemsLoading = false; state.reposLoading = false;
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
    clearAccount();
    state.restored = true;
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
  function itemStatus(item) {
    if (item.merged_at) return { text: t('Merged', '已合并'), symbol: 'arrow.triangle.merge', tone: 'accent' };
    if (item.state === 'closed') return { text: t('Closed', '已关闭'), symbol: state.kind === 'pulls' ? 'xmark.circle' : 'checkmark.circle', tone: state.kind === 'pulls' ? 'danger' : 'accent' };
    if (item.draft) return { text: t('Draft', '草稿'), symbol: 'circle.dashed', tone: 'muted' };
    return { text: t('Open', '打开'), symbol: state.kind === 'pulls' ? 'arrow.triangle.pull' : 'circle.circle', tone: 'success' };
  }
  const short = (value, limit = 512) => Array.from(String(value ?? '')).slice(0, limit).join('');
  const itemLabels = item => (Array.isArray(item.labels) ? item.labels : []).map(label => typeof label === 'string' ? label : label?.name).filter(name => typeof name === 'string' && name).map(name => short(name, 128));
  function itemDate(item) {
    const value = item.updated_at || item.created_at;
    if (typeof value !== 'string') return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleDateString(isChinese ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date(Date.now()).getFullYear() ? {} : { year: 'numeric' }) });
  }
  function filteredItems() {
    const query = state.query.trim().toLowerCase();
    return state.items.filter(item => (!query || `${item.number} ${item.title} ${item.user?.login || ''}`.toLowerCase().includes(query))
      && (!state.author || item.user?.login === state.author) && (!state.label || itemLabels(item).includes(state.label)));
  }
  function clearHiddenSelection() {
    if (state.selected && !filteredItems().some(item => item.id === state.selected.id)) {
      state.selected = null;
      state.detailsVisible = false;
    }
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
  function utf8Size(value) {
    let bytes = 0;
    for (const character of value) {
      const code = character.codePointAt(0);
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    return bytes;
  }
  function boundedText(value, maximumBytes, suffix = '') {
    if (utf8Size(value) <= maximumBytes) return value;
    const limit = maximumBytes - utf8Size(suffix);
    let bytes = 0;
    const characters = [];
    for (const character of value) {
      const size = utf8Size(character);
      if (bytes + size > limit) break;
      characters.push(character);
      bytes += size;
    }
    return characters.join('') + suffix;
  }
  function draftForSelectedItem() {
    const item = state.selected;
    if (!item || !state.detailsVisible) throw new Error(t('Select an item to hand to Nora.', '选择一条条目后才能交给 Nora。'));
    const kind = state.kind === 'pulls' ? 'PR' : 'Issue';
    const sourceURL = githubURL(item.html_url);
    const body = typeof item.body === 'string' && item.body ? item.body : t('No description.', '暂无描述。');
    const context = [t('GitHub source', 'GitHub 来源'),
      `${t('Repository', '仓库')}: ${state.repo}`, `${t('Type', '类型')}: ${kind}`, `${t('Number', '编号')}: #${item.number}`,
      `${t('Title', '标题')}: ${short(item.title, 4096)}`, `${t('State', '状态')}: ${itemStatus(item).text}`,
      `${t('Author', '作者')}: ${short(item.user?.login || t('Unknown author', '未知作者'), 64)}`,
      `${t('URL', '链接')}: ${sourceURL}`, '', `${t('Description', '描述')}:`, body].join('\n');
    return { title: boundedText(`${kind} #${item.number} · ${item.title}`, 256),
      prompt: t(`Please help me analyze and work on this GitHub ${kind}.`, `请帮我分析并处理这条 GitHub ${kind}。`),
      context: boundedText(context, 128 * 1024, '\n\n' + t('Description shortened. The full text is available at the GitHub source URL.', '描述已截断，GitHub 来源链接中保留完整内容。')),
      sourceURL };
  }
  function connectionView() {
    const children = state.error ? [node('badge', { text: state.error, tone: 'danger' })] : [];
    if (state.device) {
      children.push(styledText(state.device.userCode, 'monospaced', 'neutral'),
        button(t('Open GitHub', '打开 GitHub'), 'open-login', false, { appearance: 'primary', symbol: 'arrow.up.forward.square' }),
        button(t('Finish sign-in', '完成登录'), 'finish-login', false, { appearance: 'secondary' }),
        styledText(t('Confirm in your browser, then choose Finish sign-in.', '在浏览器确认授权后，点击“完成登录”。')),
        button(t('Cancel', '取消'), 'cancel-login'));
    } else {
      children.push(button(message.signIn, 'begin-login', false, { appearance: 'primary', symbol: 'person.crop.circle' }),
        button(state.showToken ? t('Hide access token', '收起访问 token') : t('Use an access token', '使用访问 token'), 'toggle-token'));
      if (state.error) children.push(button(t('Try again', '重试'), 'retry-load'));
      if (state.showToken) children.push(node('secureField', { id: 'token', placeholder: t('GitHub access token', 'GitHub 访问 token') }),
        button(t('Connect with token', '使用 token 连接'), 'connect-token', false, { appearance: 'secondary' }));
      children.push(menu(t('Repository access', '仓库访问权限'), [button(message.manage, 'manage')], 'folder.badge.gearshape'),
        styledText(t('Credentials stay in your Mac’s Keychain.', '账号凭据保存在你电脑的 Keychain 中。')));
    }
    return node('emptyState', { id: 'connection', text: state.device ? t('Finish connecting GitHub', '完成 GitHub 连接') : message.connect,
      subtitle: state.device ? t('Enter this code on GitHub to authorize your account.', '在 GitHub 输入验证码，为你自己的账号授权。')
        : t('Connect your own account to browse repositories, Issues, and pull requests.', '连接你自己的账号，查看仓库、Issues 和 PR。'),
      symbol: 'chevron.left.forwardslash.chevron.right' }, children);
  }
  function repositoryMenu() {
    const children = [button(t('Open another repository…', '打开其他仓库…'), 'show-other-repo', false, { symbol: 'plus' }),
      button(message.manage, 'manage', false, { symbol: 'folder.badge.gearshape' }),
      button(t('Refresh repositories', '刷新仓库'), 'refresh-repos', state.reposLoading, { symbol: 'arrow.clockwise' })];
    return menu(state.repo ? state.repo.split('/')[1] : message.repos, children, 'folder');
  }
  function repositorySidebar() {
    const query = state.repoQuery.trim().toLowerCase();
    const matchingRepos = state.repos.filter(repo => repo.full_name.toLowerCase().includes(query));
    const repos = matchingRepos.slice(0, 600);
    const children = [node('toolbar', {}, [styledText('GitHub', 'headline', 'neutral')]), repositoryMenu(),
      node('sidebar', { id: 'view-navigation', value: `view-${state.kind}`, items: [
        node('navigationItem', { id: 'view-issues', text: 'Issues', symbol: 'circle.circle', action: 'kind:issues' }),
        node('navigationItem', { id: 'view-pulls', text: t('Pull requests', 'PR'), symbol: 'arrow.triangle.pull', action: 'kind:pulls' })
      ] }), node('divider'), styledText(t('Repositories', '仓库')),
      ...(state.repos.length >= 50 || state.repoQuery ? [node('textField', { id: 'repo-query', action: 'repo-query',
        placeholder: t('Find loaded repositories', '查找已加载的仓库'), value: state.repoQuery })] : []),
      styledText(t(`${state.repos.length} ${state.repos.length === 1 ? 'repository' : 'repositories'} loaded`, `已加载 ${state.repos.length} 个仓库`))];
    if (repos.length < matchingRepos.length) children.push(styledText(t(`Showing ${repos.length} matches. Search to find others.`, `显示 ${repos.length} 个匹配结果；搜索可查找其他仓库。`)));
    if (state.moreRepos) children.push(button(t('Load more repositories', '加载更多仓库'), 'more-repos', state.reposLoading, { symbol: 'arrow.down.circle' }));
    if (query && !repos.length) children.push(styledText(t('No matching loaded repositories.', '已加载的仓库中没有匹配结果。')));
    return node('sidebar', { id: 'repository-navigation', value: state.repo ? `repo-${state.repo}` : '', items: repos.map(repo =>
      node('navigationItem', { id: `repo-${repo.full_name}`, text: repo.full_name,
        symbol: repo.private ? 'lock' : 'folder', action: `repo:${repo.full_name}` })) }, children);
  }
  function filterMenu() {
    const authors = [...new Set([state.author, ...state.items.map(item => item.user?.login)].filter(value => typeof value === 'string' && value))].sort().slice(0, 999);
    const labels = [...new Set([state.label, ...state.items.flatMap(itemLabels)].filter(Boolean))].sort().slice(0, 999);
    return menu(t('Filter', '筛选'), [
      node('picker', { id: 'status', text: t('State on GitHub', 'GitHub 状态'), action: 'status', value: state.status,
        options: [{ value: 'open', text: t('Open', '打开') }, { value: 'closed', text: t('Closed', '已关闭') }, { value: 'all', text: t('All', '全部') }] }),
      node('divider'),
      node('picker', { id: 'author', text: t('Author in loaded items', '已加载条目的作者'), action: 'author', value: state.author,
        options: [{ value: '', text: t('All authors', '全部作者') }, ...authors.map(value => ({ value, text: value }))] }),
      node('picker', { id: 'label', text: t('Label in loaded items', '已加载条目的标签'), action: 'label', value: state.label,
        options: [{ value: '', text: t('All labels', '全部标签') }, ...labels.map(value => ({ value, text: value }))] }),
      node('divider'), button(t('Clear filters', '清除筛选'), 'clear-filters')
    ], 'line.3.horizontal.decrease');
  }
  function collectionItem(item) {
    const status = itemStatus(item), date = itemDate(item);
    const metadata = [node('badge', { text: status.text, tone: status.tone }), styledText(short(item.user?.login || t('Unknown author', '未知作者'), 64))];
    if (date) metadata.push(styledText(date));
    metadata.push(...itemLabels(item).slice(0, 2).map(label => node('badge', { text: label, tone: 'neutral' })));
    return node('collectionItem', { id: `item-${item.number}`, text: short(item.title, 4096), subtitle: `#${item.number}`,
      action: `item:${item.number}`, symbol: status.symbol, tone: status.tone }, metadata);
  }
  function detailView() {
    const item = state.selected, status = itemStatus(item), date = itemDate(item);
    return node('column', { id: 'item-details' }, [
      node('toolbar', {}, [styledText(`${state.kind === 'pulls' ? 'PR' : 'Issue'} #${item.number}`, 'monospaced'), node('spacer'),
        button(t('View on GitHub', '在 GitHub 查看'), 'open-item', false, { appearance: 'icon', symbol: 'arrow.up.forward.square' })]),
      styledText(short(item.title, 4096), 'headline', 'neutral'),
      row([node('badge', { text: status.text, tone: status.tone }), ...itemLabels(item).slice(0, 8).map(label => node('badge', { text: label, tone: 'neutral' }))]),
      styledText([short(item.user?.login || t('Unknown author', '未知作者'), 64), date].filter(Boolean).join(' · ')),
      button(t('Hand to Nora', '交给 Nora'), 'handoff-item', false, { appearance: 'primary', symbol: 'sparkles' }),
      node('divider'), node('markdown', { text: displayedBody(item.body) })
    ]);
  }
  function emptyListView() {
    if (state.itemsLoading) return node('emptyState', { text: t('Loading from GitHub…', '正在从 GitHub 加载…'),
      subtitle: state.kind === 'pulls' ? t('Fetching pull requests for this repository.', '正在获取此仓库的 PR。') : t('Fetching Issues for this repository.', '正在获取此仓库的 Issues。'), symbol: 'arrow.clockwise' }, [node('progress')]);
    if (!state.repo) return node('emptyState', { text: t('Choose your first repository', '选择第一个仓库'), subtitle: message.noRepos, symbol: 'folder' },
      [button(message.manage, 'manage', false, { appearance: 'primary' }), button(message.refresh, 'refresh-repos')]);
    if (state.error) return node('emptyState', { text: t('Couldn’t load this view', '暂时无法加载'), subtitle: state.error, symbol: 'exclamationmark.circle' },
      [button(state.error === message.expired ? t('Reconnect GitHub', '重新连接 GitHub') : t('Try again', '重试'),
        state.error === message.expired ? 'begin-login' : 'retry-load', false, { appearance: 'primary' }), button(message.manage, 'manage')]);
    const filtered = state.query || state.author || state.label;
    return node('emptyState', { text: filtered ? t('No matching loaded items', '已加载条目中没有匹配结果')
      : state.kind === 'pulls' ? t('No pull requests in this view', '此视图暂无 PR') : t('No Issues in this view', '此视图暂无 Issues'),
      subtitle: filtered ? t('Adjust your filters or search. Search only covers items already loaded.', '调整筛选或搜索条件；搜索仅覆盖已经加载的条目。')
        : t('Try another state or switch between Issues and pull requests.', '尝试其他状态，或切换 Issues 与 PR。'), symbol: state.kind === 'pulls' ? 'arrow.triangle.pull' : 'tray' },
      [button(filtered ? t('Clear filters', '清除筛选') : t('Show all states', '查看全部状态'), filtered ? 'clear-filters' : 'all-states', false, { appearance: 'secondary' })]);
  }
  function view() {
    if (!state.user) return connectionView();
    const sidebar = repositorySidebar();
    const accountMenu = menu(short(state.user.login, 64), [button(message.manage, 'manage'),
      button(t('Disconnect', '断开连接'), 'disconnect', false, { symbol: 'rectangle.portrait.and.arrow.right' })], 'person.crop.circle');
    const main = [node('toolbar', {}, [styledText(state.repo || message.repos, 'headline', 'neutral'), node('spacer'),
      button(message.refresh, 'refresh', state.itemsLoading || state.reposLoading, { appearance: 'icon', symbol: 'arrow.clockwise' }), accountMenu]), node('divider')];
    if (state.showOtherRepository) {
      main.push(node('emptyState', { id: 'other-repository', text: t('Open another repository', '打开其他仓库'),
        subtitle: t('Enter owner/name. Your connected account must have access.', '输入 owner/name；已连接的账号需要拥有访问权限。'), symbol: 'folder.badge.plus' }, [
        ...(state.error ? [node('badge', { text: state.error, tone: 'danger' })] : []),
        node('textField', { id: 'manual-repo', placeholder: 'owner/name', value: state.manualRepository }),
        row([button(t('Cancel', '取消'), 'cancel-other-repo'), button(t('Open repository', '打开仓库'), 'open-repo', false, { appearance: 'primary' })])
      ]));
      return node('workspace', { id: 'github-workspace', action: 'close-detail' }, [sidebar, column(main)]);
    }
    const maximumVisibleItems = Math.min(120, Math.floor((880 - sidebar.items.length) / 6));
    const items = filteredItems(), visibleItems = items.slice(0, maximumVisibleItems);
    main.push(node('toolbar', {}, [styledText(state.kind === 'pulls' ? t('Pull requests', 'PR') : 'Issues', 'headline', 'neutral'), node('spacer'), filterMenu(),
      node('textField', { id: 'query', action: 'query', placeholder: t('Search loaded items', '搜索已加载条目'), value: state.query, symbol: 'magnifyingglass' })]));
    const count = t(`${visibleItems.length} of ${state.items.length} loaded`, `已加载 ${state.items.length} 条，显示 ${visibleItems.length} 条`);
    main.push(row([styledText(count), node('spacer'), node('badge', { text: state.status === 'all' ? t('All states', '全部状态') : state.status === 'closed' ? t('Closed', '已关闭') : t('Open', '打开'), tone: 'muted' }),
      ...(state.author ? [node('badge', { text: state.author, tone: 'neutral' })] : []), ...(state.label ? [node('badge', { text: state.label, tone: 'neutral' })] : [])]));
    if (items.length > visibleItems.length) main.push(styledText(t(`Showing the first ${maximumVisibleItems} matches. Narrow your search to find other loaded items.`, `显示前 ${maximumVisibleItems} 个匹配结果；缩小搜索范围可查看其他已加载条目。`)));
    if (state.error && visibleItems.length) main.push(row([node('badge', { text: state.error, tone: 'danger' }),
      button(state.error === message.expired ? t('Reconnect GitHub', '重新连接 GitHub') : t('Try again', '重试'), state.error === message.expired ? 'begin-login' : 'retry-load')]));
    main.push(visibleItems.length ? node('collection', { id: 'items', value: state.selected ? `item-${state.selected.number}` : '', action: 'peek-item', items: visibleItems.map(collectionItem) }) : emptyListView());
    if (state.moreItems) main.push(button(t('Load more from GitHub', '从 GitHub 加载更多'), 'more-items', state.itemsLoading));
    const children = [sidebar, column(main)];
    if (state.selected && state.detailsVisible) children.push(detailView());
    return node('workspace', { id: 'github-workspace', action: 'close-detail' }, children);
  }
  function githubURL(url) {
    if (typeof url !== 'string' || !/^https:\/\/github\.com\/(?!\/)/.test(url) || /[\s\\]/.test(url)) throw new Error(message.invalid);
    return url;
  }
  const web = async url => nora.request('browser.open', { url: githubURL(url) });
  nora.registerPanel(panelID, async (event = {}) => {
    const revision = ++renderRevision;
    state.error = '';
    const values = event.values || {};
    try {
      const action = event.action;
      if (!['disconnect', 'cancel-login', 'begin-login', 'finish-login', 'open-login', 'connect-token', 'toggle-token'].includes(action)) await restore();
      if (action === 'disconnect' || action === 'cancel-login') {
        ++generation; clearAccount(); state.restored = true;
        if (action === 'disconnect') {
          await updateCredentials(() => nora.request('credentials.delete', { key: connectionKey }));
        }
      } else if (action === 'manage') await web('https://github.com/apps/nora-github-plugin/installations/new');
      else if (action === 'begin-login') await beginLogin();
      else if (action === 'open-login') await web('https://github.com/login/device');
      else if (action === 'finish-login') await finishLogin();
      else if (action === 'toggle-token') state.showToken = !state.showToken;
      else if (action === 'connect-token') await connectToken(values.token || '');
      else if (action === 'refresh') {
        const current = generation;
        if (await loadRepositories() && current === generation && state.repo) await loadItems();
      }
      else if (action === 'refresh-repos') await loadRepositories();
      else if (action === 'retry-load') {
        if (!state.user) { state.restored = false; await restore(); }
        else if (state.repo) await loadItems();
        else await loadRepositories();
      }
      else if (action === 'more-repos') await loadRepositories(true);
      else if (action === 'more-items') await loadItems(true);
      else if (action === 'show-other-repo') { state.showOtherRepository = true; state.manualRepository = ''; }
      else if (action === 'cancel-other-repo') { state.showOtherRepository = false; state.manualRepository = ''; }
      else if (action === 'repo-query') state.repoQuery = short(event.value ?? values['repo-query'] ?? '', 1024);
      else if (action === 'open-repo' || action === 'repository' || action?.startsWith('repo:')) {
        if (action === 'open-repo') state.manualRepository = short(values['manual-repo'], 4096);
        state.repo = repository(action === 'open-repo' ? state.manualRepository : action.startsWith('repo:') ? action.slice(5) : (event.value ?? values.repository));
        state.showOtherRepository = false; state.query = ''; state.author = ''; state.label = '';
        await loadItems();
      }
      else if (action === 'kind' || action?.startsWith('kind:')) {
        state.kind = action === 'kind' ? event.value ?? values.kind : action.slice(5);
        if (!['issues', 'pulls'].includes(state.kind)) state.kind = 'issues';
        state.showOtherRepository = false; state.query = ''; state.author = ''; state.label = '';
        await loadItems();
      }
      else if (action === 'status') { state.status = status(event.value ?? values.status); await loadItems(); }
      else if (action === 'all-states') { state.status = 'all'; await loadItems(); }
      else if (action === 'query') { state.query = short(event.value ?? values.query ?? '', 1024); clearHiddenSelection(); }
      else if (action === 'author' || action === 'label') { state[action] = short(event.value ?? values[action] ?? '', 128); clearHiddenSelection(); }
      else if (action === 'clear-filters') { state.query = ''; state.author = ''; state.label = ''; }
      else if (action?.startsWith('item:')) {
        state.selected = filteredItems().find(item => item.number === Number(action.slice(5))) || null;
        state.detailsVisible = !!state.selected;
      }
      else if (action === 'peek-item') {
        const selectedID = values.items || (state.selected ? `item-${state.selected.number}` : '');
        const selected = filteredItems().find(item => `item-${item.number}` === selectedID) || null;
        state.detailsVisible = selected ? state.selected?.id === selected.id ? !state.detailsVisible : true : false;
        state.selected = selected;
      }
      else if (action === 'close-detail') state.detailsVisible = false;
      else if (action === 'handoff-item') {
        if (!await nora.chat.openDraft(draftForSelectedItem(), event)) throw new Error(t('Nora could not open this draft. Try again.', 'Nora 暂时无法打开草稿，请重试。'));
      }
      else if (action === 'open-item' && state.selected) await web(state.selected.html_url);
    } catch (error) { if (revision === renderRevision) state.error = error?.message || message.network; }
    return view();
  });
  nora.registerCommand('com.nora.github.listRepositories', listRepositories);
  nora.registerCommand('com.nora.github.listIssues', args => listItems(args, 'issues'));
  nora.registerCommand('com.nora.github.listPullRequests', args => listItems(args, 'pulls'));
})();
