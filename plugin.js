/// <reference types="@nora/plugin-kit" />
(() => {
  'use strict';
  function createPullRequestDetails({ api, write, t, boundedText, githubURL, isCurrent, onUpdated }) {
    const names = ['repository', 'comments', 'reviews', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows', 'commits', 'files'];
    const pageSize = 30, maximumRows = 200;
    const section = () => ({ items: [], loaded: false, loading: false, error: '', nextPage: null, notice: '' });
    const invalid = () => new Error(t('GitHub returned an invalid PR response.', 'GitHub 返回了无效的 PR 结果。'));
    const staleNotice = t('The PR changed. Refresh it and confirm again.', 'PR 已更改，请刷新后重新确认。');
    let model = null, revision = 0, clearRevision = 0;
    const commentOperations = new Map(), mergeOperations = new Map();
    const shaFor = item => typeof item?.head?.sha === 'string' && /^[a-fA-F0-9]{40}$/.test(item.head.sha) ? item.head.sha.toLowerCase() : '';
    function identity(item) {
      const repo = item?.repository?.full_name;
      if (typeof repo !== 'string' || repo.length > 200 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..') || !Number.isSafeInteger(item.number) || item.number < 1) throw invalid();
      return { repo, number: item.number, key: `${repo}/${item.number}` };
    }
    const active = (record, generation = record.generation) => model === record && generation === revision && isCurrent(record.item);
    const failure = error => error?.message || t('GitHub could not be reached. Try again.', '无法连接 GitHub，请重试。');
    const pathFor = (record, name, page = 1) => {
      const base = `/repos/${record.repo}`, pull = `${base}/pulls/${record.number}`, issue = `${base}/issues/${record.number}`;
      const paths = { repository: base, comments: `${issue}/comments`, reviews: `${pull}/reviews`, reviewComments: `${pull}/comments`, timeline: `${issue}/timeline`, checks: `${base}/commits/${record.headSHA}/check-runs`, statuses: `${base}/commits/${record.headSHA}/status`, workflows: `${base}/actions/runs`, commits: `${pull}/commits`, files: `${pull}/files` };
      if (name === 'repository') return paths[name];
      return `${paths[name]}?per_page=${pageSize}&page=${page}${name === 'workflows' ? `&head_sha=${record.headSHA}` : ''}`;
    };
    function nextPage(headers, requestedPage) {
      const link = headers?.link || headers?.Link || '';
      return typeof link === 'string' && /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(link) && requestedPage < 10000 ? requestedPage + 1 : null;
    }
    function responseItems(name, data) {
      if (name === 'repository') {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
        return [];
      }
      const values = name === 'checks' ? data?.check_runs : name === 'statuses' ? data?.statuses : name === 'workflows' ? data?.workflow_runs : name === 'jobs' ? data?.jobs : data;
      if (!Array.isArray(values) || values.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw invalid();
      return values;
    }
    function deduplicate(name, items) {
      const keys = new Map();
      for (const item of items) {
        const timelineSHA = name === 'timeline' && item.event === 'committed' ? item.sha || item.commit_id : '';
        const key = /^[a-f\d]{40}$/i.test(timelineSHA || '') ? `commit:${timelineSHA.toLowerCase()}`
          : name === 'files' ? item.filename : name === 'commits' ? item.sha : item.id ?? item.node_id ?? (name === 'timeline' && item.event === 'committed' ? item.sha : undefined);
        if (typeof key !== 'string' && !Number.isSafeInteger(key)) throw invalid();
        if (typeof key === 'string' && (!key || key.length > 1024)) throw invalid();
        keys.set(String(key), item);
      }
      return [...keys.values()];
    }
    async function load(record, name, { append = false, runID = null } = {}) {
      const target = runID === null ? record.sections[name] : record.jobsByRun[runID];
      if (!target || target.loading || !active(record) || append && !target.nextPage) return;
      const operation = Symbol(name), head = record.headSHA;
      const requestedPage = append ? target.nextPage : 1;
      const requiresHead = ['checks', 'statuses', 'workflows', 'jobs'].includes(name);
      if (requiresHead && !head) {
        target.loaded = true; target.error = t('The latest commit is unavailable. Refresh this PR.', '无法获取最新提交，请刷新这条 PR。'); return;
      }
      target.operation = operation; target.loading = true; target.error = ''; target.notice = '';
      const valid = () => active(record) && target.operation === operation && (!requiresHead || record.headSHA === head);
      try {
        const path = name === 'jobs' ? `/repos/${record.repo}/actions/runs/${runID}/jobs?per_page=${pageSize}&page=${requestedPage}` : pathFor(record, name, requestedPage);
        const result = await api(path);
        if (!valid()) return;
        if (name === 'repository' && result.data?.full_name?.toLowerCase() !== record.repo.toLowerCase()) throw invalid();
        const incoming = responseItems(name, result.data).filter(item => !requiresHead || !item.head_sha || item.head_sha.toLowerCase() === head);
        const items = deduplicate(name, [...(append ? target.items : []), ...incoming]);
        target.items = items.slice(0, maximumRows);
        if (name === 'repository') target.data = result.data;
        if (name === 'statuses') target.state = result.data.state;
        target.loaded = true;
        target.nextPage = nextPage(result.headers, requestedPage);
        if (items.length >= maximumRows && (target.nextPage || items.length > maximumRows)) {
          target.nextPage = null;
          target.notice = t(`Showing the first ${maximumRows} entries. Open GitHub for the complete history.`, `已显示前 ${maximumRows} 条，完整记录请在 GitHub 查看。`);
        }
      } catch (error) {
        if (valid()) target.error = failure(error);
      } finally {
        if (valid()) target.loading = false;
      }
    }
    async function open(item, { preserveTab = false } = {}) {
      const info = identity(item), previous = model;
      const same = previous?.key === info.key;
      const record = { ...info, item, headSHA: shaFor(item), tab: preserveTab && same ? previous.tab : 'discussion', generation: ++revision,
        sections: Object.fromEntries(names.map(name => [name, section()])), jobsByRun: {},
        expandedCommitGroups: same && previous.headSHA === shaFor(item) ? new Set(previous.expandedCommitGroups || []) : new Set(),
        commitGroupMembers: same && previous.headSHA === shaFor(item) ? new Map(previous.commitGroupMembers || []) : new Map(),
        selectedFileID: preserveTab && same ? previous.selectedFileID : null, filesDetailVisible: preserveTab && same && previous.filesDetailVisible === true,
        comment: { fieldID: same ? previous.comment.fieldID : `pr-comment-${info.key}`, draft: same ? previous.comment.draft : '', error: same && previous.comment.uncertain ? previous.comment.error : '', notice: '', busy: commentOperations.has(info.key), uncertain: same ? previous.comment.uncertain : false },
        merge: { pending: null, error: '', notice: '', busy: mergeOperations.has(info.key) } };
      record.sections.repository.data = null;
      model = record;
      await Promise.all(['repository', 'reviews', 'comments', 'reviewComments', 'timeline', 'checks', 'statuses', 'workflows'].map(name => load(record, name)));
      if (active(record) && ['commits', 'files'].includes(record.tab)) await load(record, record.tab);
      return model;
    }
    async function selectTab(tab) {
      if (!model || !['discussion', 'checks', 'commits', 'files'].includes(tab)) return;
      const record = model;
      record.tab = tab;
      if (['commits', 'files'].includes(tab) && !record.sections[tab].loaded) await load(record, tab);
    }
    async function refresh(item = model?.item) {
      if (!model || !item || identity(item).key !== model.key || !active(model)) return;
      const record = model, generation = revision;
      try {
        const result = await api(`/repos/${record.repo}/pulls/${record.number}`);
        if (!active(record, generation)) return;
        const data = result.data;
        if (!data || data.number !== record.number || !['open', 'closed'].includes(data.state)) throw invalid();
        const updated = { ...record.item, ...data, repository: record.item.repository, id: record.item.id };
        onUpdated(updated);
        await open(updated, { preserveTab: true });
      } catch (error) { if (active(record, generation)) record.merge.error = failure(error); }
    }
    async function more(name) {
      if (!model || !names.includes(name)) return;
      const target = model.sections[name];
      if (target.nextPage) await load(model, name, { append: true });
      else if (target.error || !target.loaded) await load(model, name);
    }
    async function jobs(runID) {
      if (!model || !Number.isSafeInteger(runID) || runID < 1 || !model.sections.workflows.items.some(run => run.id === runID && shaFor({ head: { sha: run.head_sha } }) === model.headSHA)) return;
      const record = model;
      const existing = record.jobsByRun[runID];
      if (!existing) record.jobsByRun[runID] = section();
      const target = record.jobsByRun[runID];
      if (target.loaded && !target.nextPage && !target.error) return;
      await load(record, 'jobs', { runID, append: !!target.nextPage });
    }
    function setCommentDraft(text) {
      if (!model || model.comment.busy || typeof text !== 'string') return;
      if (text !== model.comment.draft) model.comment.uncertain = false;
      model.comment.draft = text; model.comment.error = ''; model.comment.notice = '';
    }
    const byteSize = value => {
      let size = 0;
      for (const character of value) { const code = character.codePointAt(0); size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
      return size;
    };
    async function postComment({ authorized = false } = {}) {
      const record = model;
      if (!record || record.comment.busy || commentOperations.has(record.key) || !active(record)) return;
      const comment = record.comment;
      comment.error = ''; comment.notice = '';
      if (!authorized) { comment.error = t('Choose Post comment to authorize this action.', '请点击“发表评论”以授权此操作。'); return; }
      if (!comment.draft.trim()) { comment.error = t('Write a comment before posting.', '填写留言后才能发表。'); return; }
      if (byteSize(comment.draft) > 64 * 1024) { comment.error = t('This comment exceeds 64 KiB. Shorten it before posting.', '留言超过 64 KiB，请缩短后发表。'); return; }
      if (comment.uncertain) { comment.error = t('The previous comment may have been posted. Check GitHub before trying again.', '上一条留言可能已经发表，请先在 GitHub 确认，再尝试。'); return; }
      const draft = comment.draft, generation = revision;
      comment.busy = true; commentOperations.set(record.key, comment);
      try {
        const result = await write(`/repos/${record.repo}/issues/${record.number}/comments`, 'POST', { body: draft });
        if (!active(record, generation)) return;
        if (result.status !== 201 || !result.data || !Number.isSafeInteger(result.data.id) || result.data.id < 1 || typeof result.data.body !== 'string') {
          const error = invalid(); error.status = result.status; error.uncertain = result.status === 201; throw error;
        }
        record.sections.comments.items = deduplicate('comments', [...record.sections.comments.items, result.data]).slice(-maximumRows);
        comment.draft = ''; comment.fieldID = `pr-comment-${record.key}-${++clearRevision}`; comment.uncertain = false;
        comment.notice = t('Comment posted.', '留言已发表。');
      } catch (error) {
        if (active(record, generation)) {
          comment.uncertain = error?.uncertain === true || !Number.isInteger(error?.status);
          comment.error = comment.uncertain ? t('The result could not be confirmed. Check GitHub before posting again; your draft is saved.', '无法确认发表结果。请先在 GitHub 确认后再发表；草稿已保留。') : failure(error);
        }
      } finally {
        if (commentOperations.get(record.key) === comment) commentOperations.delete(record.key);
        if (active(record, generation)) comment.busy = false;
        else if (model?.key === record.key) model.comment.busy = false;
      }
    }
    function mergeBase(item, fallbackRepository) {
      const ref = item.base?.ref, repo = item.base?.repo?.full_name ?? fallbackRepository;
      if (typeof ref !== 'string' || !ref || typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
      return { repo: repo.toLowerCase(), ref };
    }
    function mergeProblem(record, method, repositoryData = record.sections.repository.data) {
      if (record.item.merged || record.item.merged_at || record.item.state !== 'open') return t('This PR is already closed or merged.', '这条 PR 已关闭或已合并。');
      if (record.item.draft === true) return t('A draft PR cannot be merged.', '草稿 PR 不能合并。');
      if (!record.headSHA) return t('The latest commit is unavailable. Refresh this PR.', '无法获取最新提交，请刷新这条 PR。');
      if (!mergeBase(record.item, record.repo)) return t('The target branch is unavailable. Refresh this PR.', '无法获取目标分支，请刷新这条 PR。');
      if (repositoryData?.archived === true) return t('An archived repository cannot be changed.', '仓库已归档，无法修改。');
      if (!repositoryData || repositoryData.permissions?.push !== true) return t('Write access to this repository is required to merge.', '合并需要此仓库的写入权限。');
      const setting = { merge: 'allow_merge_commit', squash: 'allow_squash_merge', rebase: 'allow_rebase_merge' }[method];
      if (!setting || repositoryData[setting] !== true) return t('This merge method is not enabled for this repository.', '此仓库未启用该合并方式。');
      if (record.item.mergeable === false || record.item.mergeable_state === 'dirty') return t('This PR has conflicts. Resolve them before merging.', '这条 PR 存在冲突，请解决后再合并。');
      if (record.item.mergeable_state === 'blocked') return t('Repository rules currently block merging.', '仓库规则暂时阻止合并。');
      if (record.item.mergeable_state === 'behind') return t('Update the source branch before merging.', '更新来源分支后再合并。');
      if (record.item.mergeable !== true || record.item.mergeable_state === 'unknown') return t('GitHub is calculating merge status. Refresh to check again.', 'GitHub 正在计算合并状态，刷新后再确认。');
      return '';
    }
    function prepareMerge(method) {
      const record = model;
      if (!record || record.merge.busy || !active(record)) return;
      record.merge.error = ''; record.merge.notice = ''; record.merge.pending = null;
      const problem = mergeProblem(record, method);
      if (problem) { record.merge.error = problem; return; }
      const base = mergeBase(record.item, record.repo);
      record.merge.pending = { repo: record.repo, number: record.number, sha: record.headSHA, method, baseRepo: base.repo, baseRef: base.ref };
    }
    function cancelMerge() {
      if (!model || model.merge.busy) return;
      model.merge.pending = null; model.merge.error = ''; model.merge.notice = '';
    }
    async function confirmMerge({ authorized = false } = {}) {
      const record = model;
      if (!record || record.merge.busy || mergeOperations.has(record.key) || !record.merge.pending || !active(record)) return;
      const merge = record.merge, pending = merge.pending, generation = revision;
      merge.error = ''; merge.notice = '';
      if (!authorized) { merge.error = t('Choose Confirm merge to authorize this action.', '请点击“确认合并”以授权此操作。'); return; }
      const base = mergeBase(record.item, record.repo);
      if (pending.repo !== record.repo || pending.number !== record.number || pending.sha !== record.headSHA || base?.repo !== pending.baseRepo || base?.ref !== pending.baseRef) { merge.pending = null; merge.error = staleNotice; return; }
      merge.busy = true; mergeOperations.set(record.key, merge);
      let writeDispatched = false;
      const valid = () => active(record, generation) && merge.pending === pending;
      try {
        const result = await api(`/repos/${record.repo}/pulls/${record.number}`);
        if (!valid()) return;
        if (!result.data || result.data.number !== record.number || !['open', 'closed'].includes(result.data.state)) throw invalid();
        const fresh = { ...record.item, ...result.data, mergeable: result.data.mergeable, mergeable_state: result.data.mergeable_state, base: result.data.base, repository: record.item.repository, id: record.item.id };
        const freshBase = mergeBase(fresh, record.repo);
        if (shaFor(fresh) !== pending.sha || freshBase?.repo !== pending.baseRepo || freshBase?.ref !== pending.baseRef || fresh.draft === true || fresh.state !== 'open' || fresh.merged || fresh.merged_at) {
          record.item = fresh; record.headSHA = shaFor(fresh); onUpdated(fresh);
          record.sections.checks = section(); record.sections.statuses = section(); record.sections.workflows = section(); record.jobsByRun = {};
          merge.pending = null; merge.error = staleNotice; return;
        }
        const repositoryResult = await api(`/repos/${record.repo}`);
        if (!valid()) return;
        if (repositoryResult.data?.full_name?.toLowerCase() !== record.repo.toLowerCase()) throw invalid();
        record.sections.repository.data = repositoryResult.data;
        record.item = fresh; onUpdated(fresh);
        const problem = mergeProblem({ ...record, item: fresh }, pending.method, repositoryResult.data);
        if (problem) { merge.pending = null; merge.error = problem; return; }
        writeDispatched = true;
        const response = await write(`/repos/${record.repo}/pulls/${record.number}/merge`, 'PUT', { sha: pending.sha, merge_method: pending.method });
        if (!valid()) return;
        if (response.status !== 200 || response.data?.merged !== true) {
          merge.error = t('GitHub did not merge this PR. Check its requirements on GitHub.', 'GitHub 未合并这条 PR，请在 GitHub 检查合并要求。'); merge.pending = null; return;
        }
        record.item = { ...fresh, state: 'closed', merged: true, ...(typeof response.data.sha === 'string' ? { merge_commit_sha: response.data.sha } : {}) };
        onUpdated(record.item);
        merge.pending = null; merge.notice = t('PR merged.', 'PR 已合并。');
      } catch (error) {
        if (valid()) {
          merge.pending = null;
          merge.error = writeDispatched && (error?.uncertain === true || !Number.isInteger(error?.status)) ? t('The merge result could not be confirmed. Check GitHub before trying again.', '无法确认合并结果，请先在 GitHub 确认后再尝试。') : failure(error);
        }
      } finally {
        if (mergeOperations.get(record.key) === merge) mergeOperations.delete(record.key);
        if (active(record, generation)) merge.busy = false;
        else if (model?.key === record.key) model.merge.busy = false;
      }
    }
    function context() {
      if (!model || !active(model)) return '';
      const record = model, lines = [`PR #${record.number} · ${record.repo}`, `${t('Latest commit', '最新提交')}: ${record.headSHA || t('Unavailable', '不可用')}`];
      const append = (label, target, describe) => {
        lines.push(`${label}: ${target.error || (!target.loaded ? t('Not loaded', '尚未加载') : target.items.length ? `${target.items.length}${target.nextPage ? '+' : ''}` : t('No reports', '暂无记录'))}`);
        if (target.loaded) lines.push(...target.items.slice(-8).map(describe));
        if (target.notice) lines.push(target.notice);
      };
      append(t('Latest-commit CI checks', '最新提交的 CI 检查'), record.sections.checks, check => `- ${check.name || 'Check'}: ${check.conclusion || check.status || 'unknown'}`);
      append(t('Commit statuses', '提交状态'), record.sections.statuses, status => `- ${status.context || 'Status'}: ${status.state || 'unknown'}`);
      append('Actions', record.sections.workflows, run => `- ${run.name || 'Workflow'}: ${run.conclusion || run.status || 'unknown'}`);
      append(t('Reviews', '审查'), record.sections.reviews, review => `- ${review.user?.login || 'Unknown'}: ${review.state || 'unknown'}${review.body ? ` · ${boundedText(String(review.body), 600, '…')}` : ''}`);
      append(t('Comments', '留言'), record.sections.comments, comment => `- ${comment.user?.login || 'Unknown'}: ${boundedText(String(comment.body || ''), 800, '…')}`);
      append(t('Inline comments', '行内留言'), record.sections.reviewComments, comment => `- ${comment.user?.login || 'Unknown'} · ${comment.path || ''}:${comment.line || comment.original_line || ''}: ${boundedText(String(comment.body || ''), 500, '…')}`);
      append(t('Activity', '活动'), record.sections.timeline, event => `- ${event.event || 'unknown'} · ${event.actor?.login || event.user?.login || ''}`);
      let url = '';
      try { url = githubURL(record.item.html_url); } catch {}
      if (url) lines.push(`${t('Source', '来源')}: ${url}`);
      return boundedText(lines.join('\n'), 14 * 1024, '\n…');
    }
    return { get current() { return model; }, reset() { ++revision; model = null; }, open, selectTab, refresh, more, jobs, setCommentDraft, postComment, prepareMerge, confirmMerge, cancelMerge, context };
  }
  function createPullRequestView({ node, t, boundedText, displayedBody, short, itemStatus, itemDate, avatarFor = () => null, onAuthorButton = () => {}, currentUser = () => null, supportsTextEditor = true, supportsNativeLayout = false, supportsNativeDiff = false, supportsNativeTimeline = false, supportsDetailAside = false, supportsItemRowIcon = false, now = () => Date.now() }) {
    const commitGroupIconSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M9 12H3m12 0h6"/></g></svg>';
    const text = (value, textStyle = 'caption', tone = 'muted') => node('text', { text: boundedText(String(value ?? ''), 4096, '…'), textStyle, tone });
    const column = children => node('column', {}, children);
    const row = children => node('row', {}, children);
    const badge = (label, tone = 'muted', symbol) => node('badge', { text: short(label, 512), tone, ...(symbol ? { symbol } : {}) });
    const button = (label, action, properties = {}) => node('button', { text: short(label, 256), action, appearance: 'plain', ...properties });
    const section = (model, name) => model.sections?.[name] || model[name] || { items: [], loaded: false, loading: false, error: '', nextPage: null };
    const items = (model, name) => Array.isArray(section(model, name).items) ? section(model, name).items : [];
    const referenceLayout = supportsDetailAside && supportsNativeLayout && supportsNativeTimeline;
    const hasDetailAside = model => referenceLayout && !!model.sections && (!model.tab || ['discussion', 'overview'].includes(model.tab));
    const prURL = model => `https://github.com/${model.repo}/pull/${model.number}`;
    const safeURL = (url, fallback) => typeof url === 'string' && /^https:\/\/github\.com\/(?!\/)[^\s\\]+$/.test(url) ? url : fallback;
    const openAction = (url, fallback) => {
      const safe = safeURL(url, fallback), encoded = encodeURIComponent(safe);
      const fallbackEncoded = encodeURIComponent(fallback);
      return `pr-open:${encoded.length <= 246 ? encoded : fallbackEncoded.length <= 246 ? fallbackEncoded : encodeURIComponent('https://github.com/')}`;
    };
    const open = (model, label, url, suffix = '', properties = {}) => button(label, openAction(url, prURL(model) + suffix), { symbol: 'arrow.up.forward.square', ...properties });
    const timestamp = entry => entry.submitted_at || entry.created_at || entry.commit?.author?.date || (entry.event === 'committed' ? entry.author?.date : '') || '';
    const date = entry => itemDate({ updated_at: timestamp(entry) || entry.completed_at || entry.started_at || entry.updated_at });
    const relativeDate = entry => {
      const created = Date.parse(timestamp(entry)), elapsed = now() - created;
      if (!Number.isFinite(created) || !Number.isFinite(elapsed)) return '';
      const seconds = Math.abs(elapsed) / 1000;
      if (seconds < 60) return t('now', '刚刚');
      const units = [[31536000, 'y', '年'], [2592000, 'mo', '个月'], [604800, 'w', '周'], [86400, 'd', '天'], [3600, 'h', '小时'], [60, 'm', '分钟']];
      const [duration, suffix, chinese] = units.find(([duration]) => seconds >= duration);
      const count = Math.floor(seconds / duration);
      return elapsed < 0 ? t(`in ${count}${suffix}`, `${count}${chinese}后`) : t(`${count}${suffix}`, `${count}${chinese}前`);
    };
    const account = (entry, model) => {
      if (entry.event === 'committed') {
        if (typeof entry.author?.login === 'string' && entry.author.login) return entry.author;
        const commit = /^[a-f\d]{40}$/i.test(entry.sha || '') ? items(model, 'commits').find(value => value.sha?.toLowerCase() === entry.sha.toLowerCase()) : null;
        if (typeof commit?.author?.login === 'string' && commit.author.login) return commit.author;
        return entry.author && typeof entry.author === 'object' ? entry.author : {};
      }
      const candidates = [entry.user, entry.actor, entry.author];
      const author = candidates.find(value => typeof value?.login === 'string' && value.login);
      if (author) return author;
      return candidates.find(value => value && typeof value === 'object') || {};
    };
    const authorButton = (model, entry, fallback) => {
      const author = account(entry, model), avatar = avatarFor(author);
      const label = short(author.login || author.name || entry.commit?.author?.name || t('Unknown author', '未知作者'), 80);
      const result = button(label, openAction(author.html_url, fallback), { tone: 'neutral', ...(avatar ? { avatarBase64: avatar } : { symbol: 'person.crop.circle' }) });
      onAuthorButton(result, author, entry);
      return result;
    };
    const markdown = (value, maximum = 8 * 1024) => node('markdown', { text: boundedText(String(value || ''), maximum, '\n\n' + t('Content shortened. View on GitHub for the full text.', '内容已缩短，完整内容可在 GitHub 查看。')) });
    const code = (value, language = '') => {
      const body = boundedText(String(value || ''), 8 * 1024, '\n' + t('… Patch shortened.', '… 变更内容已缩短。'));
      const runs = body.match(/`+/g) || [], fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
      return node('markdown', { text: `${fence}${language}\n${body}\n${fence}` });
    };
    const countNodes = value => 1 + (value.children || []).reduce((sum, child) => sum + countNodes(child), 0) + (value.items || []).reduce((sum, child) => sum + countNodes(child), 0);
    const bytes = value => {
      let result = 0;
      for (const character of value) { const point = character.codePointAt(0); result += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }
      return result;
    };
    const encodedSize = value => {
      const normalize = entry => {
        const { avatarBase64, ...withoutAvatar } = entry;
        return { ...(entry.type === 'button' ? withoutAvatar : entry), options: entry.options || [], disabled: entry.disabled || false,
          children: (entry.children || []).map(normalize), items: (entry.items || []).map(normalize) };
      };
      return bytes(JSON.stringify(value.map(normalize)).replace(/\//g, '\\/'));
    };
    const commitGroupRows = new WeakMap();
    function fittedCommitGroup(card, maximumNodes, maximumBytes) {
      const group = commitGroupRows.get(card);
      if (!group || countNodes(card) <= maximumNodes && encodedSize([card]) <= maximumBytes) return card;
      const kept = [], header = card.children[0];
      const notice = count => text(t(`Showing ${count} of ${group.rows.length} loaded commits.`, `显示已加载的 ${group.rows.length} 次提交中的 ${count} 次。`));
      const link = button(t('View all commits', '查看全部提交'), 'pr-tab:commits', { symbol: 'chevron.right' });
      const fixed = [header, notice(group.rows.length), link];
      let nodes = 1 + fixed.reduce((sum, child) => sum + countNodes(child), 0), size = encodedSize([node('column', { id: card.id }, fixed)]);
      if (nodes > maximumNodes || size > maximumBytes) return null;
      for (const child of group.rows) {
        const childNodes = countNodes(child), childBytes = encodedSize([child]);
        if (nodes + childNodes > maximumNodes || size + childBytes > maximumBytes) break;
        kept.push(child); nodes += childNodes; size += childBytes;
      }
      return node('column', { id: card.id }, [header, ...kept, notice(kept.length), link]);
    }
    const fit = (model, header, cards, footer, suffix, preferRecent = false, reservedNodes = 0) => {
      const overflow = [badge(t('More activity is available on GitHub.', '还有更多内容，可在 GitHub 查看。'), 'muted'), open(model, t('View complete history', '查看完整内容'), prURL(model) + suffix, suffix)];
      const fixed = [...header, ...footer, ...overflow];
      const aside = hasDetailAside(model) ? nativeAside(model) : [];
      let nodes = reservedNodes + aside.reduce((sum, value) => sum + countNodes(value), 0) + fixed.reduce((sum, value) => sum + countNodes(value), 0), size = encodedSize([...fixed, ...aside]);
      const kept = [];
      for (const card of preferRecent ? cards.slice().reverse() : cards) {
        const candidate = fittedCommitGroup(card, 200 - nodes, 185 * 1024 - size);
        if (!candidate) break;
        const nextNodes = countNodes(candidate), nextSize = encodedSize([candidate]);
        if (nodes + nextNodes > 200 || size + nextSize > 185 * 1024) break;
        kept.push(candidate); nodes += nextNodes; size += nextSize;
      }
      if (preferRecent) kept.reverse();
      return [...header, ...kept, ...(kept.length < cards.length ? overflow : []), ...footer];
    };
    const sectionState = (model, name, label) => {
      const value = section(model, name), result = [];
      if (value.loading) result.push(node('progress', { text: t(`Loading ${label}…`, `正在加载${label}…`) }));
      if (value.error) result.push(row([badge(`${label}: ${short(value.error, 400)}`, 'warning', 'exclamationmark.circle'), button(t('Try again', '重试'), `pr-more:${name}`, { disabled: !!value.loading })]));
      if (value.notice) result.push(text(`${label}: ${value.notice}`));
      if (value.nextPage && !value.error) result.push(button(t(`Load more ${label}`, `加载更多${label}`), `pr-more:${name}`, { symbol: 'arrow.down.circle', disabled: !!value.loading }));
      return result;
    };
    const status = entry => {
      const state = String(entry.conclusion || entry.state || entry.status || '').toLowerCase();
      if (state === 'success') return { text: t('Passed', '通过'), tone: 'success', symbol: 'checkmark.circle' };
      if (['failure', 'error', 'timed_out'].includes(state)) return { text: state === 'timed_out' ? t('Timed out', '超时') : t('Failed', '失败'), tone: 'danger', symbol: 'xmark.circle' };
      if (['in_progress', 'pending', 'waiting', 'requested', 'queued'].includes(state)) return { text: ['in_progress', 'pending'].includes(state) ? t('Running', '运行中') : t('Queued', '等待中'), tone: 'warning', symbol: 'clock' };
      if (state === 'cancelled') return { text: t('Cancelled', '已取消'), tone: 'muted', symbol: 'minus.circle' };
      if (state === 'skipped') return { text: t('Skipped', '已跳过'), tone: 'muted', symbol: 'minus.circle' };
      if (state === 'neutral') return { text: t('Neutral', '中立'), tone: 'muted', symbol: 'minus.circle' };
      if (state === 'action_required') return { text: t('Action required', '需要处理'), tone: 'warning', symbol: 'exclamationmark.circle' };
      if (state === 'stale') return { text: t('Stale', '已过期'), tone: 'muted', symbol: 'clock' };
      if (state === 'completed') return { text: t('Completed', '已完成'), tone: 'muted', symbol: 'checkmark.circle' };
      return { text: t('Unknown', '未知'), tone: 'muted', symbol: 'questionmark.circle' };
    };
    const statusBadge = entry => node('badge', status(entry));
    const headItems = (model, name) => items(model, name).filter(entry => !entry.head_sha || entry.head_sha === model.headSHA);
    const reviewState = value => {
      const state = String(value || '').toUpperCase();
      if (state === 'APPROVED') return badge(t('Approved', '已批准'), 'success', 'checkmark.circle');
      if (state === 'CHANGES_REQUESTED') return badge(t('Changes requested', '要求修改'), 'danger', 'exclamationmark.circle');
      if (state === 'DISMISSED') return badge(t('Dismissed', '已撤销审查'), 'muted', 'minus.circle');
      if (state === 'PENDING') return badge(t('Pending review', '待提交审查'), 'warning', 'clock');
      return badge(t('Reviewed', '已审查'), 'muted', 'text.bubble');
    };
    const repository = model => section(model, 'repository').data || {};
    const merged = item => !!(item.merged === true || item.merged_at || item.pull_request?.merged_at);
    const mergeState = item => {
      if (merged(item)) {
        const status = itemStatus(item);
        return node('badge', { text: t('Merged', '已合并'), tone: status.tone === 'purple' ? 'purple' : 'accent', symbol: 'arrow.triangle.merge',
          ...(status.iconSVG ? { iconSVG: status.iconSVG } : {}) });
      }
      if (item.state === 'closed') return badge(t('Closed', '已关闭'), 'danger', 'xmark.circle');
      if (item.draft) return badge(t('Draft', '草稿'), 'muted', 'circle.dashed');
      if (item.mergeable === false || item.mergeable_state === 'dirty') return badge(t('Merge conflicts', '存在合并冲突'), 'danger', 'exclamationmark.triangle');
      if (item.mergeable === null || item.mergeable === undefined || item.mergeable_state === 'unknown') return badge(t('Merge status pending', '合并状态待确认'), 'muted', 'clock');
      if (item.mergeable_state === 'blocked') return badge(t('Merge is blocked', '合并受阻'), 'warning', 'lock');
      if (item.mergeable_state === 'behind') return badge(t('Branch is behind', '分支需要更新'), 'warning', 'arrow.triangle.branch');
      return badge(t('No merge conflicts', '无合并冲突'), 'success', 'checkmark.circle');
    };
    function summary(model) {
      const item = model.item || {}, repo = repository(model), reviewItems = items(model, 'reviews');
      const latest = new Map();
      for (const review of reviewItems.slice().sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')))) {
        if (review.user?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(String(review.state).toUpperCase())) latest.set(review.user.login, String(review.state).toUpperCase());
      }
      const approvals = [...latest.values()].filter(value => value === 'APPROVED').length;
      const requested = [...latest.values()].filter(value => value === 'CHANGES_REQUESTED').length;
      const checks = [...headItems(model, 'checks'), ...headItems(model, 'statuses')];
      const complete = checks.filter(entry => !['in_progress', 'pending', 'waiting', 'requested', 'queued', ''].includes(String(entry.conclusion || entry.state || entry.status || '').toLowerCase())).length;
      const failed = checks.filter(entry => status(entry).tone === 'danger').length;
      const branch = [item.base?.label || item.base?.ref, item.head?.label || item.head?.ref].filter(Boolean).join(' ← ');
      const reviewSection = section(model, 'reviews'), reviewLoaded = reviewSection.loaded;
      const reviewPartial = !reviewLoaded || reviewSection.loading || reviewSection.nextPage || reviewSection.notice;
      const ciPartial = ['checks', 'statuses', 'workflows'].some(name => {
        const value = section(model, name);
        return !value.loaded || value.loading || value.error || value.nextPage || value.notice;
      });
      const runs = headItems(model, 'workflows'), runsCompleted = runs.filter(run => run.status === 'completed').length, runsFailed = runs.filter(run => status(run).tone === 'danger').length;
      return [
        ...(branch ? [text(branch, 'monospaced')] : []),
        row([...(item.state === 'open' && !item.draft && !merged(item) ? [mergeState(item)] : []),
          ...(reviewSection.error ? [badge(t(`Reviews: ${short(reviewSection.error, 180)}`, `审查：${short(reviewSection.error, 180)}`), 'warning', 'exclamationmark.circle')] : reviewLoaded ? [badge(t(`${reviewPartial ? 'Loaded reviews: ' : ''}${approvals} approved · ${requested} requesting changes`, `${reviewPartial ? '已加载审查：' : ''}${approvals} 人批准 · ${requested} 人要求修改`), requested || reviewPartial ? 'warning' : approvals ? 'success' : 'muted', 'person.crop.circle.badge.checkmark')] : [badge(reviewSection.loading ? t('Reviews loading', '审查加载中') : t('Reviews not loaded', '审查尚未加载'), 'muted', 'clock')]),
          ...(checks.length ? [badge(t(`${complete}/${checks.length} loaded checks finished${failed ? ` · ${failed} failed` : ''}${ciPartial ? ' · incomplete' : ''}`, `${complete}/${checks.length} 项已加载检查结束${failed ? ` · ${failed} 项失败` : ''}${ciPartial ? ' · 信息不完整' : ''}`), failed ? 'danger' : ciPartial ? 'warning' : complete === checks.length ? 'success' : 'warning', 'checklist')] : []),
          ...(runs.length ? [badge(t(`${ciPartial ? 'Loaded Actions' : 'Actions'} ${runsCompleted}/${runs.length} finished${runsFailed ? ` · ${runsFailed} failed` : ''}${ciPartial ? ' · incomplete' : ''}`, `${ciPartial ? '已加载 Actions' : 'Actions'} ${runsCompleted}/${runs.length} 项结束${runsFailed ? ` · ${runsFailed} 项失败` : ''}${ciPartial ? ' · 信息不完整' : ''}`), runsFailed ? 'danger' : ciPartial ? 'warning' : runsCompleted === runs.length ? 'success' : 'warning', 'play.circle')] : [])]),
        ...(Number.isInteger(item.commits) || Number.isInteger(item.changed_files) ? [row([
          ...(Number.isInteger(item.commits) ? [text(t(`${item.commits} commits`, `${item.commits} 次提交`))] : []),
          ...(Number.isInteger(item.changed_files) ? [text(t(`${item.changed_files} files changed`, `${item.changed_files} 个文件变更`))] : []),
          ...(Number.isInteger(item.additions) ? [text(`+${item.additions}`, 'monospaced', 'success')] : []),
          ...(Number.isInteger(item.deletions) ? [text(`−${item.deletions}`, 'monospaced', 'danger')] : [])
        ])] : []),
        ...(merged(item) ? [text(t(`Merged${item.merged_by?.login ? ` by ${item.merged_by.login}` : ''}${item.merged_at ? ` · ${date({ created_at: item.merged_at })}` : ''}`, `已合并${item.merged_by?.login ? ` · ${item.merged_by.login}` : ''}${item.merged_at ? ` · ${date({ created_at: item.merged_at })}` : ''}`))] : []),
        ...(repo.archived ? [badge(t('Repository is archived', '仓库已归档'), 'muted', 'archivebox')] : []),
        row(['discussion', 'checks', 'commits', 'files'].map(tab => {
          const label = { discussion: t('Discussion', '讨论'), checks: t('Checks', '检查'), commits: t('Commits', '提交'), files: t('Files', '文件') }[tab];
          return button(label, `pr-tab:${tab}`, { id: `pr-tab-${tab}`, value: model.tab === tab || tab === 'discussion' && model.tab === 'overview' ? 'selected' : '' });
        })), node('divider')
      ];
    }
    function eventLabel(entry) {
      const label = entry.label?.name;
      const assignee = entry.assignee?.login;
      const reviewer = entry.requested_reviewer?.login || entry.requested_team?.name;
      const labels = {
        closed: t('closed this PR', '关闭了这个 PR'), reopened: t('reopened this PR', '重新打开了这个 PR'),
        merged: t('merged this PR', '合并了这个 PR'), committed: t('pushed a commit', '提交了代码'),
        head_ref_force_pushed: t('force-pushed the source branch', '强制更新了来源分支'), head_ref_deleted: t('deleted the source branch', '删除了来源分支'),
        head_ref_restored: t('restored the source branch', '恢复了来源分支'), base_ref_changed: t('changed the target branch', '修改了目标分支'),
        ready_for_review: t('marked ready for review', '标记为可以审查'), convert_to_draft: t('converted to a draft', '转为草稿'),
        review_requested: t(`requested a review${reviewer ? ` from ${reviewer}` : ''}`, `请求审查${reviewer ? ` · ${reviewer}` : ''}`),
        review_request_removed: t(`removed a review request${reviewer ? ` for ${reviewer}` : ''}`, `取消了审查请求${reviewer ? ` · ${reviewer}` : ''}`),
        review_dismissed: t('dismissed a review', '撤销了审查'),
        labeled: t(`added label${label ? ` ${label}` : ''}`, `添加了标签${label ? ` · ${label}` : ''}`),
        unlabeled: t(`removed label${label ? ` ${label}` : ''}`, `移除了标签${label ? ` · ${label}` : ''}`),
        assigned: t(`assigned${assignee ? ` ${assignee}` : ''}`, `指派了负责人${assignee ? ` · ${assignee}` : ''}`),
        unassigned: t(`unassigned${assignee ? ` ${assignee}` : ''}`, `移除了负责人${assignee ? ` · ${assignee}` : ''}`),
        renamed: t(`renamed the PR${entry.rename?.to ? ` to ${entry.rename.to}` : ''}`, `修改了 PR 标题${entry.rename?.to ? ` · ${entry.rename.to}` : ''}`),
        locked: t('locked the discussion', '锁定了讨论'), unlocked: t('unlocked the discussion', '解锁了讨论'),
        milestoned: t(`set milestone${entry.milestone?.title ? ` ${entry.milestone.title}` : ''}`, `设置了里程碑${entry.milestone?.title ? ` · ${entry.milestone.title}` : ''}`),
        demilestoned: t('removed the milestone', '移除了里程碑'), auto_merge_enabled: t('enabled auto-merge', '启用了自动合并'), auto_merge_disabled: t('disabled auto-merge', '关闭了自动合并'),
        deployed: t('deployed this PR', '部署了这个 PR'), deployment_environment_changed: t('changed the deployment environment', '修改了部署环境'),
        mentioned: t('mentioned this PR', '提到了这个 PR'), subscribed: t('subscribed to this PR', '关注了这个 PR'), unsubscribed: t('unsubscribed from this PR', '取消关注了这个 PR')
      };
      if (entry.event === 'cross-referenced') return t(`referenced this PR${entry.source?.issue?.title ? ` · ${entry.source.issue.title}` : ''}`, `引用了这个 PR${entry.source?.issue?.title ? ` · ${entry.source.issue.title}` : ''}`);
      return labels[entry.event] || t(`Activity · ${String(entry.event || '').replace(/_/g, ' ')}`, `动态 · ${String(entry.event || '').replace(/_/g, ' ')}`);
    }
    function discussionActivity(model) {
      const sources = [['comments', t('Comments', '留言')], ['reviews', t('Reviews', '审查')], ['reviewComments', t('Inline comments', '代码留言')], ['timeline', t('Activity', '动态')]];
      const activity = [];
      const known = Object.fromEntries(['comments', 'reviews', 'reviewComments'].map(name => [name, new Set(items(model, name).map(entry => String(entry.id)))]));
      const timelineCommits = new Set();
      for (const [name] of sources) for (const entry of items(model, name)) {
        let source = name;
        if (name === 'timeline') {
          const sha = entry.event === 'committed' ? entry.sha || entry.commit_id : '';
          if (/^[a-f\d]{40}$/i.test(sha || '')) {
            if (timelineCommits.has(sha.toLowerCase())) continue;
            timelineCommits.add(sha.toLowerCase());
          }
          if (entry.event === 'line-commented' && Array.isArray(entry.comments)) {
            for (const comment of entry.comments) if (!known.reviewComments.has(String(comment.id))) activity.push({ source: 'reviewComments', entry: comment, timestamp: comment.created_at || entry.created_at || '' });
            continue;
          }
          source = { commented: 'comments', reviewed: 'reviews', 'line-commented': 'reviewComments' }[entry.event] || name;
          if (source !== name && known[source].has(String(entry.id))) continue;
        }
        activity.push({ source, entry, timestamp: timestamp(entry) });
      }
      activity.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || String(a.entry.id || '').localeCompare(String(b.entry.id || '')));
      return { sources, activity };
    }
    const commitGroupKey = (model, first, last) => {
      const source = `${model.key || `${model.repo}/${model.number}`}|${(first.sha || first.commit_id).toLowerCase()}|${(last.sha || last.commit_id).toLowerCase()}`;
      let left = 2166136261, right = 2246822507;
      for (let index = 0; index < source.length; index++) {
        left = Math.imul(left ^ source.charCodeAt(index), 16777619);
        right = Math.imul(right ^ source.charCodeAt(index), 3266489917);
      }
      return (left >>> 0).toString(16).padStart(8, '0') + (right >>> 0).toString(16).padStart(8, '0');
    };
    function groupedActivity(model, activity) {
      const result = [], members = new Map();
      const previousExpanded = model.expandedCommitGroups || new Set(), previousMembers = model.commitGroupMembers || new Map();
      const isCommit = value => value.source === 'timeline' && value.entry.event === 'committed' && /^[a-f\d]{40}$/i.test(value.entry.sha || value.entry.commit_id || '');
      const loaded = new Set(activity.filter(isCommit).map(value => (value.entry.sha || value.entry.commit_id).toLowerCase()));
      for (let index = 0; index < activity.length;) {
        if (!isCommit(activity[index])) { result.push(activity[index++]); continue; }
        const entries = [];
        while (index < activity.length && isCommit(activity[index])) entries.push(activity[index++]);
        if (entries.length === 1) { result.push(entries[0]); continue; }
        const key = commitGroupKey(model, entries[0].entry, entries.at(-1).entry);
        members.set(key, new Set(entries.map(value => (value.entry.sha || value.entry.commit_id).toLowerCase())));
        result.push({ entries, key });
      }
      const currentKeys = new Set(members.keys()), expanded = new Set();
      const timeline = section(model, 'timeline'), complete = timeline.loaded && !timeline.loading && !timeline.error && !timeline.nextPage && !timeline.notice;
      for (const key of previousExpanded) {
        const remembered = previousMembers.get(key) || new Set();
        const matches = [...currentKeys].filter(current => [...members.get(current)].some(sha => remembered.has(sha)));
        if (!matches.length && !complete) { members.set(key, new Set(remembered)); expanded.add(key); continue; }
        for (const current of matches) expanded.add(current);
        if (!complete && matches.length) for (const sha of remembered) if (!loaded.has(sha)) members.get(matches.at(-1)).add(sha);
      }
      let count = [...members.values()].reduce((sum, commits) => sum + commits.size, 0);
      for (const [key, commits] of members) {
        if (count <= 400) break;
        if (currentKeys.has(key)) continue;
        members.delete(key); expanded.delete(key); count -= commits.size;
      }
      model.commitGroupMembers = members;
      model.expandedCommitGroups = expanded;
      return result;
    }
    function toggleCommitGroup(model, key) {
      if (!supportsNativeTimeline || !/^[a-f\d]{16}$/.test(key)) return false;
      if (!groupedActivity(model, discussionActivity(model).activity).some(value => value.key === key)) return false;
      if (model.expandedCommitGroups.has(key)) model.expandedCommitGroups.delete(key);
      else model.expandedCommitGroups.add(key);
      return true;
    }
    function discussion(model) {
      const { sources, activity } = discussionActivity(model);
      const cards = activity.slice(-80).map(({ source, entry }) => {
        const nodes = [row([authorButton(model, entry, prURL(model)), text(date(entry)), node('spacer'),
          ...(source === 'reviews' ? [reviewState(entry.state)] : [badge(source === 'reviewComments' ? t('Code comment', '代码留言') : source === 'comments' ? t('Comment', '留言') : t('Activity', '动态'))])])];
        if (source === 'timeline') {
          nodes.push(text(eventLabel(entry), 'body', 'neutral'));
          if (entry.commit_id || entry.sha) nodes.push(text(short(entry.commit_id || entry.sha, 12), 'monospaced'));
          if (entry.dismissed_review?.dismissal_message) nodes.push(markdown(entry.dismissed_review.dismissal_message, 2048));
        } else {
          if (source === 'reviewComments') nodes.push(text([entry.path, Number.isInteger(entry.line || entry.original_line) ? t(`line ${entry.line || entry.original_line}`, `第 ${entry.line || entry.original_line} 行`) : '', entry.in_reply_to_id ? t(`Reply to #${entry.in_reply_to_id}`, `回复 #${entry.in_reply_to_id}`) : ''].filter(Boolean).join(' · '), 'monospaced'));
          if (entry.body) nodes.push(markdown(entry.body, 6 * 1024));
          else if (source === 'reviews') nodes.push(text(t('Review submitted without a message.', '已提交审查，没有附加留言。')));
        }
        nodes.push(node('divider'));
        return column(nodes);
      });
      const header = [text(t('Description', '描述'), 'headline', 'neutral'), node('markdown', { text: displayedBody(model.item?.body) }), node('divider'), text(t('Conversation & activity', '讨论与动态'), 'headline', 'neutral')];
      if (!activity.length && sources.every(([name]) => section(model, name).loaded && !section(model, name).error)) header.push(text(t('No comments or activity yet.', '暂无留言或动态。')));
      const footer = sources.flatMap(([name, label]) => sectionState(model, name, label));
      if (activity.length > 80) footer.push(text(t('Showing a limited portion of loaded history. GitHub contains the full history.', '这里只显示部分已加载动态，GitHub 中保留完整记录。')));
      return fit(model, header, cards, footer, '', true);
    }
    function selectedList(list, id, limit = 30) {
      const selection = list.find(entry => String(entry.id) === String(id));
      const visible = list.slice(0, limit);
      if (selection && !visible.includes(selection)) visible.splice(Math.max(0, visible.length - 1), 1, selection);
      return visible;
    }
    function actionsView(model, runs) {
      const cards = [], run = runs.find(entry => String(entry.id) === String(model.selectedRunID)) || runs[0];
      const visibleRuns = selectedList(runs, run?.id);
      cards.push(column([text(t('Workflows', '工作流'), 'headline', 'neutral'), ...visibleRuns.map(entry => {
        const result = status(entry);
        return button(`${result.text} · ${short(entry.name || entry.display_title || 'GitHub Actions', 150)}${entry.run_number ? ` · #${entry.run_number}` : ''}`, `pr-jobs:${entry.id}`,
          { value: run && String(entry.id) === String(run.id) ? 'selected' : '', symbol: result.symbol, tone: result.tone });
      }), ...(runs.length > visibleRuns.length ? [text(t('Showing 30 loaded workflows. More runs are available on GitHub.', '显示 30 个已加载工作流，更多记录可在 GitHub 查看。'))] : [])]));
      if (!run) return cards;
      cards.push(row([text(short(run.name || run.display_title || 'GitHub Actions', 256), 'headline', 'neutral'), statusBadge(run), open(model, t('View run', '查看运行记录'), run.html_url, '/checks')]));
      cards.push(text([run.run_number ? `#${run.run_number}` : '', run.event, date(run)].filter(Boolean).join(' · ')));
      const value = model.jobsByRun?.[run.id];
      if (!value) { cards.push(button(t('Load jobs & steps', '加载任务与步骤'), `pr-jobs:${run.id}`, { symbol: 'list.bullet.rectangle' })); return cards; }
      if (value.loading) cards.push(node('progress', { text: t('Loading jobs…', '正在加载任务…') }));
      if (value.error) cards.push(row([badge(short(value.error, 512), 'warning'), button(t('Retry jobs', '重试任务'), `pr-jobs:${run.id}`, { disabled: !!value.loading })]));
      if (value.notice) cards.push(text(value.notice));
      const jobs = Array.isArray(value.items) ? value.items : [], job = jobs.find(entry => String(entry.id) === String(model.selectedJobID)) || jobs[0];
      const visibleJobs = selectedList(jobs, job?.id);
      if (jobs.length) cards.push(column([text(t('Jobs', '任务'), 'headline', 'neutral'), ...visibleJobs.map(entry => {
        const result = status(entry);
        return button(`${result.text} · ${short(entry.name || t('Job', '任务'), 180)}`, `pr-job:${entry.id}`, { value: job && String(entry.id) === String(job.id) ? 'selected' : '', symbol: result.symbol, tone: result.tone });
      }), ...(jobs.length > visibleJobs.length ? [text(t('Showing 30 loaded jobs. More jobs are available in this run on GitHub.', '显示 30 个已加载任务，更多任务可在 GitHub 的运行记录中查看。'))] : [])]));
      else if (value.loaded && !value.error) cards.push(text(t('No jobs were reported for this run.', '这个工作流暂无任务记录。')));
      if (value.nextPage) cards.push(button(t('Load more jobs', '加载更多任务'), `pr-jobs:${run.id}`, { disabled: !!value.loading }));
      if (!job) return cards;
      const steps = Array.isArray(job.steps) ? job.steps : [], completed = steps.filter(step => step.status === 'completed').length;
      cards.push(row([text(short(job.name || t('Job', '任务'), 256), 'headline', 'neutral'), statusBadge(job), open(model, t('View job', '查看任务'), job.html_url, '/checks')]));
      cards.push(text(t(`${completed}/${steps.length} steps finished`, `${completed}/${steps.length} 个步骤已结束`)));
      cards.push(column(steps.slice(0, 30).map(step => row([statusBadge(step), text(`${step.number || ''} ${step.name || ''}`, 'body', 'neutral')]))));
      if (steps.length > 30) cards.push(text(t('Showing the first 30 steps. The complete step list is available in this job on GitHub.', '显示前 30 个步骤，完整步骤可在 GitHub 的任务页面查看。')));
      return cards;
    }
    function checksView(model) {
      const checks = headItems(model, 'checks'), statuses = headItems(model, 'statuses'), workflows = headItems(model, 'workflows');
      const sources = ['actions', 'checks', 'statuses'];
      const source = sources.includes(model.checksSource) ? model.checksSource : workflows.length ? 'actions' : checks.length ? 'checks' : statuses.length ? 'statuses' : 'actions';
      const names = { actions: 'GitHub Actions', checks: t('Check runs', '检查项'), statuses: t('Commit statuses', '提交状态') };
      const counts = { actions: workflows.length, checks: checks.length, statuses: statuses.length };
      const header = [text(t(`Checks for current commit ${short(model.headSHA, 12)}`, `当前提交 ${short(model.headSHA, 12)} 的检查`), 'headline', 'neutral'), text(t('These are reported checks; repository rules determine whether merging is allowed.', '这里显示实际检查结果；能否合并由仓库规则决定。')),
        row(sources.map(name => button(`${names[name]}${counts[name] ? ` · ${counts[name]}` : ''}`, `pr-ci:${name}`, { value: source === name ? 'selected' : '' }))), node('divider')];
      let cards = [];
      if (source === 'actions') cards = actionsView(model, workflows);
      if (source === 'checks') for (const check of checks.slice(0, 80)) cards.push(column([row([statusBadge(check), open(model, short(check.name || t('Check', '检查'), 256), check.details_url || check.html_url, '/checks', { tone: 'neutral' })]),
        ...(check.output?.title ? [text(check.output.title, 'body', 'neutral')] : []),
        ...(check.output?.summary ? [markdown(check.output.summary, 4 * 1024)] : []),
        ...(check.started_at || check.completed_at ? [text(date(check))] : []), node('divider')]));
      if (source === 'statuses') for (const check of statuses.slice(0, 80)) cards.push(column([row([statusBadge(check), open(model, short(check.context || t('Status', '状态'), 256), check.target_url, '/checks', { tone: 'neutral' })]),
        ...(check.description ? [text(check.description, 'body', 'neutral')] : []), text(date(check)), node('divider')]));
      const sourceName = source === 'actions' ? 'workflows' : source, current = section(model, sourceName);
      if (!counts[source] && current.loaded && !current.error) header.push(text(t(`No ${names[source]} were reported for this commit.`, `这个提交暂无${names[source]}记录。`)));
      const footer = [['checks', t('Checks', '检查项')], ['statuses', t('Commit statuses', '提交状态')], ['workflows', 'GitHub Actions']].flatMap(([name, label]) => sectionState(model, name, label));
      return fit(model, header, cards, footer, '/checks');
    }
    function commitsView(model) {
      const list = items(model, 'commits');
      const cards = list.slice(0, 80).map(commit => column([
        row([open(model, short(commit.sha, 12), commit.html_url, '/commits', { tone: 'accent' }), text(date(commit))]),
        text(String(commit.commit?.message || '').split('\n')[0], 'headline', 'neutral'),
        authorButton(model, commit, prURL(model) + '/commits'),
        ...(String(commit.commit?.message || '').includes('\n') ? [markdown(String(commit.commit.message).split('\n').slice(1).join('\n').trim(), 2048)] : []), node('divider')
      ]));
      const header = [text(t('Commits', '提交'), 'headline', 'neutral')];
      if (!list.length && section(model, 'commits').loaded && !section(model, 'commits').error) header.push(text(t('No commits returned.', '暂无提交记录。')));
      return fit(model, header, cards, sectionState(model, 'commits', t('Commits', '提交')), '/commits');
    }
    function filesView(model) {
      const list = items(model, 'files');
      const labels = { added: t('Added', '新增'), removed: t('Removed', '删除'), modified: t('Modified', '修改'), renamed: t('Renamed', '重命名'), copied: t('Copied', '复制'), changed: t('Changed', '变更'), unchanged: t('Unchanged', '未变更') };
      const cards = list.slice(0, 80).map(file => column([
        row([badge(labels[file.status] || file.status || t('Changed', '变更'), file.status === 'added' ? 'success' : file.status === 'removed' ? 'danger' : 'muted'),
          open(model, short(file.filename || t('File', '文件'), 256), file.blob_url, '/files', { tone: 'neutral' })]),
        row([text(`+${Number.isInteger(file.additions) ? file.additions : 0}`, 'monospaced', 'success'), text(`−${Number.isInteger(file.deletions) ? file.deletions : 0}`, 'monospaced', 'danger')]),
        ...(file.previous_filename ? [text(t(`Previously ${file.previous_filename}`, `原文件名 · ${file.previous_filename}`), 'monospaced')] : []),
        ...(file.patch ? [code(file.patch, 'diff')] : [text(t('A text diff is unavailable. View this file on GitHub.', '没有可显示的文本差异，可在 GitHub 查看此文件。'))]), node('divider')
      ]));
      const header = [text(t('Changed files', '文件变更'), 'headline', 'neutral')];
      if (!list.length && section(model, 'files').loaded && !section(model, 'files').error) header.push(text(t('No changed files returned.', '暂无文件变更记录。')));
      return fit(model, header, cards, sectionState(model, 'files', t('Files', '文件')), '/files');
    }
    function content(model) {
      if (!model) return [];
      if (model.tab === 'checks') return checksView(model);
      if (model.tab === 'commits') return commitsView(model);
      if (model.tab === 'files') return filesView(model);
      return discussion(model);
    }
    function commentActions(model) {
      const comment = model.comment || {}, repo = repository(model);
      const result = [node('divider')];
      if ((model.tab === 'discussion' || model.tab === 'overview' || !model.tab) && !supportsTextEditor) {
        result.push(text(t('Update Nora to use the native comment editor.', '更新 Nora 后即可使用原生留言编辑框。')),
          open(model, t('Comment on GitHub', '在 GitHub 留言'), prURL(model)), node('divider'));
      } else if (model.tab === 'discussion' || model.tab === 'overview' || !model.tab) {
        result.push(text(t('Leave a comment', '留言'), 'headline', 'neutral'), node('textEditor', { id: comment.fieldID || `pr-comment-${model.key}`, text: t('Comment', '留言'), textStyle: 'body', placeholder: t('Write a comment…', '写下你的留言…'), value: comment.draft || '', disabled: !!comment.busy }),
          row([button(comment.busy ? t('Posting…', '正在发送…') : t('Post comment', '发送留言'), 'pr-comment', { appearance: 'secondary', symbol: 'text.bubble', disabled: !!comment.busy || !!repo.archived })]));
        if (comment.error) result.push(badge(comment.error, 'danger', 'exclamationmark.circle'));
        if (comment.notice) result.push(badge(comment.notice, 'success', 'checkmark.circle'));
        if (comment.uncertain) result.push(badge(t('The response was interrupted. Refresh the discussion before sending again.', '响应中断，重新发送前请刷新讨论确认留言是否已发布。'), 'warning', 'exclamationmark.circle'));
        result.push(node('divider'));
      }
      return result;
    }
    function mergeActions(model) {
      const item = model.item || {}, merge = model.merge || {}, repo = repository(model), repoState = section(model, 'repository');
      const result = [text(t('Merge', '合并'), 'headline', 'neutral')];
      if (merge.notice) result.push(badge(merge.notice, 'success', 'checkmark.circle'));
      if (merge.error) result.push(badge(merge.error, 'danger', 'exclamationmark.circle'));
      if (merged(item)) { result.push(text(t('This pull request has been merged.', '这个 PR 已合并。'))); return result; }
      if (item.state === 'closed') { result.push(text(t('This pull request is closed.', '这个 PR 已关闭。'))); return result; }
      if (item.draft) { result.push(badge(t('A draft must be marked ready for review before merging.', '草稿需要标记为可以审查后才能合并。'), 'muted', 'circle.dashed')); return result; }
      if (repo.archived) { result.push(badge(t('An archived repository cannot be changed.', '仓库已归档，无法修改。'), 'muted', 'archivebox')); return result; }
      if (merge.pending) {
        const method = { merge: t('Merge commit', '合并提交'), squash: t('Squash and merge', '压缩并合并'), rebase: t('Rebase and merge', '变基并合并') }[merge.pending.method] || merge.pending.method;
        result.push(badge(t('Confirm merge', '确认合并'), 'warning', 'arrow.triangle.merge'), text(t(`${method} · ${merge.pending.repo} #${merge.pending.number}`, `${method} · ${merge.pending.repo} #${merge.pending.number}`), 'body', 'neutral'),
          text(t(`This will merge commit ${short(merge.pending.sha, 12)} into ${item.base?.ref || 'the target branch'}.`, `将提交 ${short(merge.pending.sha, 12)} 合并到 ${item.base?.ref || '目标分支'}。`)),
          row([button(t('Cancel', '取消'), 'pr-cancel-merge', { disabled: !!merge.busy }), button(merge.busy ? t('Merging…', '正在合并…') : t('Confirm merge', '确认合并'), 'pr-confirm-merge', { appearance: 'primary', symbol: 'arrow.triangle.merge', disabled: !!merge.busy })]));
        return result;
      }
      if (repoState.loading || !repoState.loaded && !repoState.error) { result.push(node('progress', { text: t('Checking repository permissions…', '正在检查仓库权限…') })); return result; }
      if (repoState.error) result.push(badge(t('Repository permissions could not be loaded.', '无法获取仓库权限。'), 'warning', 'exclamationmark.circle'), button(t('Retry permissions', '重试权限'), 'pr-more:repository'));
      if (repo.permissions?.push !== true) {
        result.push(text(t('Merge permission is unavailable for this account or connection.', '当前账号或连接尚未获得合并权限。')), button(t('Manage repository access', '管理仓库访问权限'), 'manage', { symbol: 'folder.badge.gearshape' }), open(model, t('View merge options on GitHub', '在 GitHub 查看合并选项'), prURL(model)));
        return result;
      }
      if (item.mergeable === false || item.mergeable_state === 'dirty') { result.push(badge(t('Resolve merge conflicts before merging.', '解决合并冲突后才能合并。'), 'danger', 'exclamationmark.triangle')); return result; }
      if (item.mergeable_state === 'blocked' || item.mergeable_state === 'behind') { result.push(badge(item.mergeable_state === 'blocked' ? t('Repository rules currently block merging.', '仓库规则暂时阻止合并。') : t('Update the source branch before merging.', '更新来源分支后再合并。'), 'warning', 'lock'), open(model, t('View merge requirements on GitHub', '在 GitHub 查看合并要求'), prURL(model))); return result; }
      if (item.mergeable === null || item.mergeable === undefined || item.mergeable_state === 'unknown') { result.push(text(t('GitHub is calculating merge status. Refresh to check again.', 'GitHub 正在计算合并状态，刷新后再确认。')), button(t('Refresh status', '刷新状态'), 'pr-refresh', { symbol: 'arrow.clockwise' })); return result; }
      const methods = [['merge', 'allow_merge_commit', t('Merge commit', '合并提交')], ['squash', 'allow_squash_merge', t('Squash and merge', '压缩并合并')], ['rebase', 'allow_rebase_merge', t('Rebase and merge', '变基并合并')]].filter(([, field]) => repo[field] === true);
      if (methods.length) result.push(row(methods.map(([method, , label]) => button(label, `pr-merge:${method}`, { appearance: 'secondary', symbol: 'arrow.triangle.merge', disabled: !!merge.busy }))));
      else result.push(text(t('No merge method is explicitly enabled for this repository.', '仓库没有明确启用可用的合并方式。')), open(model, t('View merge options on GitHub', '在 GitHub 查看合并选项'), prURL(model)));
      result.push(text(t('GitHub will enforce repository rules, checks, and the current commit when you confirm.', '确认时，GitHub 会检查仓库规则、检查结果以及当前提交。')));
      return result;
    }
    function actions(model) { return [...commentActions(model), ...mergeActions(model)]; }
    const nativeRow = (title, subtitle = '', properties = {}, children = []) => {
      const { value, ...rest } = properties;
      return node('itemRow', { text: short(title, 512), ...(subtitle ? { subtitle: short(subtitle, 512) } : {}),
        ...rest, ...(value === 'selected' ? { value } : {}) }, children);
    };
    const duration = entry => {
      const start = Date.parse(entry.started_at || ''), end = Date.parse(entry.completed_at || '');
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
      const seconds = Math.round((end - start) / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
      return minutes < 60 ? `${minutes}m ${remainder}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    };
    const resultRow = (entry, title, action, properties = {}, trailing = []) => {
      const result = status(entry), elapsed = duration(entry);
      return nativeRow(title, '', { ...(action ? { action } : {}), symbol: result.symbol, tone: result.tone, ...properties },
        [...(elapsed ? [text(elapsed, 'monospaced')] : []), ...trailing]);
    };
    function tabs(model) {
      const labels = { discussion: t('Discussion', '讨论'), checks: t('Checks', '检查'), commits: t('Commits', '提交'), files: t('Files', '文件') };
      const symbols = { discussion: 'text.bubble', checks: 'checkmark.circle', commits: 'arrow.triangle.branch', files: 'doc.on.doc' };
      const checks = headItems(model, 'checks').length + headItems(model, 'statuses').length;
      const counts = { discussion: Number(model.item?.comments || 0), checks, commits: model.item?.commits, files: model.item?.changed_files };
      return node('tabBar', { id: 'pr-tabs' }, Object.keys(labels).map(tab => button(labels[tab], `pr-tab:${tab}`, {
        id: `pr-tab-${tab}`, symbol: symbols[tab], ...(model.tab === tab || tab === 'discussion' && model.tab === 'overview' ? { value: 'selected' } : {}),
        ...(Number.isInteger(counts[tab]) && counts[tab] > 0 ? { subtitle: String(counts[tab]) } : {}),
      })));
    }
    function nativeReadiness(model) {
      const checks = [...headItems(model, 'checks'), ...headItems(model, 'statuses')], runs = headItems(model, 'workflows');
      const incomplete = ['checks', 'statuses', 'workflows'].some(name => { const value = section(model, name); return !value.loaded || value.loading || value.error || value.nextPage || value.notice; });
      const results = checks.length ? checks : runs;
      const failed = results.filter(entry => status(entry).tone === 'danger').length;
      const pending = results.filter(entry => ['in_progress', 'pending', 'waiting', 'requested', 'queued'].includes(String(entry.conclusion || entry.state || entry.status || '').toLowerCase())).length;
      const terminal = new Set(['success', 'failure', 'error', 'timed_out', 'cancelled', 'skipped', 'neutral', 'action_required', 'stale', 'completed']);
      const done = results.filter(entry => terminal.has(String(entry.conclusion || entry.state || entry.status || '').toLowerCase())).length;
      const checkLabel = !results.length ? t('No checks reported', '暂无检查记录')
        : failed ? t(`${failed} ${failed === 1 ? 'check failed' : 'checks failed'}`, `${failed} 项检查失败`)
          : pending ? t(`${pending} ${pending === 1 ? 'check running' : 'checks running'}`, `${pending} 项检查运行中`)
            : done === results.length ? t(`${done} ${done === 1 ? 'check completed' : 'checks completed'}`, `${done} 项检查已结束`)
              : t('Check status pending', '检查状态待确认');
      const allSuccessful = results.length > 0 && results.every(entry => status(entry).tone === 'success');
      const checkTone = failed ? 'danger' : incomplete || pending ? 'warning' : allSuccessful ? 'success' : 'muted';
      const latestReviews = new Map();
      for (const review of items(model, 'reviews').slice().sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')))) {
        if (review.user?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(String(review.state).toUpperCase())) latestReviews.set(review.user.login, String(review.state).toUpperCase());
      }
      const approvals = [...latestReviews.values()].filter(value => value === 'APPROVED').length, requested = [...latestReviews.values()].filter(value => value === 'CHANGES_REQUESTED').length;
      const reviews = section(model, 'reviews'), reviewsIncomplete = !reviews.loaded || reviews.loading || reviews.error || reviews.nextPage || reviews.notice;
      const reviewLabel = requested ? t('Changes requested', '有审查要求修改') : approvals ? t(`${approvals} ${approvals === 1 ? 'approval' : 'approvals'}`, `${approvals} 人批准`)
        : items(model, 'reviews').length ? t('Awaiting approval', '尚未批准') : t('No reviews yet', '暂无审查');
      const merge = mergeState(model.item || {});
      if (supportsNativeTimeline) return node('column', { id: 'pr-readiness' }, [
        node('divider'), row([
          button(incomplete ? t(`${checkLabel} · partial`, `${checkLabel} · 信息不完整`) : checkLabel, 'pr-tab:checks',
            { symbol: failed ? 'xmark.circle' : pending || incomplete ? 'clock' : allSuccessful ? 'checkmark.circle' : 'checklist', tone: checkTone }),
          node('badge', { text: reviewsIncomplete ? t(`${reviewLabel} · partial`, `${reviewLabel} · 信息不完整`) : reviewLabel,
            symbol: 'person.crop.circle.badge.checkmark', appearance: 'plain', tone: requested ? 'danger' : reviewsIncomplete ? 'warning' : 'muted' }),
          node('spacer'), merged(model.item || {}) ? node('badge', { ...merge, appearance: 'plain' })
            : button(merge.text, 'pr-toggle-merge', { symbol: merge.symbol, tone: merge.tone }),
        ]),
        ...(reviews.error ? [text(short(reviews.error, 256), 'caption', 'warning')] : []),
      ]);
      return node('column', { id: 'pr-readiness', ...(!supportsNativeTimeline ? { appearance: 'secondary' } : {}) }, [
        ...(supportsNativeTimeline ? [node('divider')] : []),
        nativeRow(incomplete ? t(`${checkLabel} · partial results`, `${checkLabel} · 信息不完整`) : checkLabel,
          incomplete ? t('Some results could not be loaded. Open Checks for details.', '部分结果尚未获取，点击检查查看详情。') : supportsNativeTimeline ? '' : t('View checks and workflow runs', '查看检查与工作流记录'),
          { action: 'pr-tab:checks', symbol: failed ? 'xmark.circle' : pending || incomplete ? 'clock' : allSuccessful ? 'checkmark.circle' : 'checklist', tone: checkTone }),
        nativeRow(reviewsIncomplete ? t(`${reviewLabel} · partial results`, `${reviewLabel} · 信息不完整`) : reviewLabel,
          reviews.error ? short(reviews.error, 256) : '', { symbol: 'person.crop.circle.badge.checkmark', tone: requested ? 'danger' : reviewsIncomplete ? 'warning' : approvals ? 'success' : 'muted' }),
        nativeRow(merge.text, supportsNativeTimeline ? '' : t('Review merge options', '查看合并选项'), { action: 'pr-toggle-merge', symbol: merge.symbol, tone: merge.tone,
          ...(supportsItemRowIcon && merge.iconSVG ? { iconSVG: merge.iconSVG } : {}) }),
      ]);
    }
    function nativeAside(model) {
      if (!hasDetailAside(model)) return [];
      const item = model.item || {};
      const incomplete = name => { const value = section(model, name); return !value.loaded || value.loading || value.error || value.nextPage || value.notice; };
      const contextSection = (id, label, children) => node('column', { id: `pr-aside-${id}` }, [text(label), ...children]);
      const changes = [row([
        button(Number.isInteger(item.changed_files) ? t(`${item.changed_files} files`, `${item.changed_files} 个文件`) : t('View files', '查看文件'), 'pr-tab:files', { symbol: 'doc.on.doc', tone: 'neutral' }),
        node('spacer'), ...(Number.isInteger(item.additions) ? [text(`+${item.additions}`, 'caption', 'success')] : []),
        ...(Number.isInteger(item.deletions) ? [text(`−${item.deletions}`, 'caption', 'danger')] : []),
      ])];
      const reviewers = new Map();
      for (const review of items(model, 'reviews').slice().sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')))) {
        if (!review.user?.login) continue;
        const key = review.user.login.toLowerCase(), previous = reviewers.get(key), state = String(review.state || '').toUpperCase();
        if (state === 'COMMENTED' && previous && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(previous.state)) continue;
        reviewers.set(key, { account: review.user, state });
      }
      for (const account of Array.isArray(item.requested_reviewers) ? item.requested_reviewers : []) {
        if (account?.login) reviewers.set(account.login.toLowerCase(), { account, state: 'REQUESTED' });
      }
      const reviewRows = [...reviewers.values()].slice(0, 6).map(review => row([
        authorButton(model, { user: review.account }, prURL(model)), node('spacer'),
        review.state === 'REQUESTED' ? badge(t('Requested', '待审查'), 'muted', 'circle') : reviewState(review.state),
      ]));
      const teams = (Array.isArray(item.requested_teams) ? item.requested_teams : []).filter(team => typeof (team?.name || team?.slug) === 'string').slice(0, 3);
      reviewRows.push(...teams.map(team => row([text(short(team.name || team.slug, 80), 'caption', 'neutral'), node('spacer'), badge(t('Requested', '待审查'), 'muted', 'person.2')])));
      if (!reviewRows.length) reviewRows.push(text(incomplete('reviews') ? t('Reviewers not available yet', '审查人信息尚未获取') : t('No reviewers', '暂无审查人')));
      if (reviewers.size > 6 || (item.requested_teams || []).length > 3) reviewRows.push(open(model, t('View all reviewers', '查看所有审查人'), prURL(model)));
      if (incomplete('reviews')) reviewRows.push(text(t('Review information is incomplete', '审查信息不完整'), 'caption', 'warning'));
      const commentRows = [];
      for (const [key, name, en, zh] of [['comments', 'comments', 'discussion comments', '条讨论留言'], ['review_comments', 'reviewComments', 'code comments', '条代码留言']]) {
        const known = Number.isInteger(item[key]) && item[key] >= 0, count = known ? item[key] : items(model, name).length;
        if (known || section(model, name).loaded || count) commentRows.push(button(known ? t(`${count} ${en}`, `${count} ${zh}`) : t(`${count} loaded ${en}`, `已加载 ${count} ${zh}`), 'pr-tab:discussion', { symbol: 'text.bubble', tone: 'neutral' }));
      }
      if (!commentRows.length) commentRows.push(text(t('Comments not loaded', '留言尚未加载')));
      if (['comments', 'reviewComments'].some(incomplete)) commentRows.push(text(t('Comment history is incomplete', '留言记录不完整'), 'caption', 'warning'));
      const checks = [...headItems(model, 'checks'), ...headItems(model, 'statuses')];
      const results = checks.length ? checks : headItems(model, 'workflows');
      const priority = entry => { const tone = status(entry).tone; return tone === 'danger' ? 0 : tone === 'warning' ? 1 : 2; };
      const checkRows = results.slice().sort((a, b) => priority(a) - priority(b)).slice(0, 6).map((entry, index) => nativeRow(short(entry.name || entry.context || t('Check', '检查'), 160), '', {
        id: `pr-aside-check-${index}`, action: 'pr-tab:checks', symbol: status(entry).symbol, tone: status(entry).tone,
      }));
      const ciIncomplete = ['checks', 'statuses', 'workflows'].some(incomplete);
      if (!checkRows.length) checkRows.push(text(ciIncomplete ? t('Checks not available yet', '检查信息尚未获取') : t('No checks reported', '暂无检查记录')));
      if (ciIncomplete) checkRows.push(text(t('Check results are incomplete', '检查信息不完整'), 'caption', 'warning'));
      if (results.length > 6 || ciIncomplete) checkRows.push(button(t('View all checks', '查看全部检查'), 'pr-tab:checks', { symbol: 'chevron.right' }));
      const merge = mergeState(item);
      return [node('column', { id: 'pr-context-aside' }, [
        contextSection('changes', t('Changes', '变更'), changes), node('divider'),
        contextSection('reviewers', t('Reviewers', '审查人'), reviewRows), node('divider'),
        contextSection('comments', t('Comments', '留言'), commentRows), node('divider'),
        contextSection('checks', t('Checks', '检查'), checkRows), node('divider'),
        contextSection('merge', t('Merge status', '合并状态'), [nativeRow(merge.text, '', { action: 'pr-toggle-merge', symbol: merge.symbol, tone: merge.tone,
          ...(supportsItemRowIcon && merge.iconSVG ? { iconSVG: merge.iconSVG } : {}) }),
          ...(repository(model).archived ? [text(t('Repository is archived', '仓库已归档'))] : [])]),
      ])];
    }
    function nativeDescription(model, sourceURL = prURL(model), id = 'pr-description') {
      const labels = (Array.isArray(model.item?.labels) ? model.item.labels : []).map(label => typeof label === 'string' ? label : label?.name).filter(label => typeof label === 'string' && label);
      const created = date(model.item || {});
      if (referenceLayout && model.sections) return node('column', { id }, [
        ...(labels.length ? [text(labels.join(' · '))] : []), node('markdown', { text: displayedBody(model.item?.body) }),
      ]);
      if (supportsNativeTimeline) return node('timelineItem', { id, value: 'comment' }, [
        authorButton(model, model.item || {}, sourceURL),
        row([...(created ? [text(t(`opened ${created}`, `创建于 ${created}`))] : []), node('spacer')]),
        column([...(labels.length ? [text(labels.join(' · '))] : []), node('markdown', { text: displayedBody(model.item?.body) })]),
      ]);
      return node('column', { id, appearance: 'secondary' }, [
        row([authorButton(model, model.item || {}, sourceURL), ...(created ? [text(t(`opened ${created}`, `创建于 ${created}`))] : []), node('spacer')]),
        ...(labels.length ? [text(labels.join(' · '))] : []),
        node('markdown', { text: displayedBody(model.item?.body) }),
      ]);
    }
    function nativeDiscussion(model) {
      if (supportsNativeTimeline) return timelineDiscussion(model);
      const { sources, activity } = discussionActivity(model);
      const description = nativeDescription(model);
      const cards = activity.slice(-80).map(({ source, entry }, index) => {
        const isEvent = source === 'timeline';
        if (isEvent && entry.event === 'committed' && !entry.dismissed_review?.dismissal_message) {
          const sha = entry.sha || entry.commit_id, created = date(entry);
          const commitURL = /^[a-f\d]{40}$/i.test(sha || '') ? `https://github.com/${model.repo}/commit/${sha}` : prURL(model) + '/commits';
          return node('row', { id: `pr-activity-${index}` }, [
            authorButton(model, entry, prURL(model)), text(eventLabel(entry)),
            ...(sha ? [button(short(sha, 12), openAction(commitURL, prURL(model) + '/commits'))] : []),
            node('spacer'), ...(created ? [text(created)] : []),
          ]);
        }
        const header = row([authorButton(model, entry, prURL(model)),
          text(isEvent ? [eventLabel(entry), date(entry)].filter(Boolean).join(' · ') : date(entry)), node('spacer'),
          ...(source === 'reviews' ? [reviewState(entry.state)] : []),
          ...(!isEvent ? [open(model, t('View comment on GitHub', '在 GitHub 查看留言'), entry.html_url, '', { appearance: 'icon' })] : []),
        ]);
        const children = [header];
        if (isEvent) {
          if (entry.commit_id || entry.sha) children.push(text(short(entry.commit_id || entry.sha, 12), 'monospaced'));
          if (entry.dismissed_review?.dismissal_message) children.push(markdown(entry.dismissed_review.dismissal_message, 2048));
        } else {
          if (source === 'reviewComments') children.push(text([entry.path, Number.isInteger(entry.line || entry.original_line) ? t(`line ${entry.line || entry.original_line}`, `第 ${entry.line || entry.original_line} 行`) : '', entry.in_reply_to_id ? t(`Reply to #${entry.in_reply_to_id}`, `回复 #${entry.in_reply_to_id}`) : ''].filter(Boolean).join(' · '), 'monospaced'));
          if (entry.body) children.push(markdown(entry.body, 6 * 1024));
          else if (source === 'reviews') children.push(text(t('Review submitted without a message.', '已提交审查，没有附加留言。')));
        }
        return node('column', { id: `pr-activity-${index}`, appearance: isEvent ? 'plain' : 'secondary' }, children);
      });
      const groupedCards = [];
      for (const card of cards) {
        if (card.type !== 'row') { groupedCards.push(card); continue; }
        const previous = groupedCards[groupedCards.length - 1];
        if (previous?.id?.startsWith('pr-activity-group-') && previous.children.length < 6) previous.children.push(card);
        else groupedCards.push(node('column', { id: `pr-activity-group-${card.id}` }, [card]));
      }
      const footer = sources.flatMap(([name, label]) => sectionState(model, name, label));
      if (activity.length > 80) footer.push(text(t('Showing part of the loaded history. View the full conversation on GitHub.', '这里只显示部分已加载记录，完整讨论可在 GitHub 查看。')));
      footer.push(nativeReadiness(model), ...nativeCommentComposer(model));
      return fit(model, [description], groupedCards, footer, '', true);
    }
    function timelineDiscussion(model) {
      const commentBody = (source, entry) => {
        const body = String(entry.body || '');
        const isBot = entry.user?.type === 'Bot' || /^[a-z\d][a-z\d-]*\[bot\]$/i.test(entry.user?.login || '');
        const tableDivider = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m;
        const complex = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,}|\|)|(?:^|\n)[ \t]{4}\S|<(?:table|details|pre)\b/i.test(body) || tableDivider.test(body);
        if (source !== 'comments' || !isBot || Array.from(body).length <= 200 && !complex) return [markdown(body, 6 * 1024)];
        // Keep the first HTML pass from interpreting user tags or extracting code before the body is decoded and parsed as Markdown.
        const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '`': '&#96;', '~': '&#126;', '\r': '&#13;', '\n': '&#10;' };
        const encoded = body.replace(/[&<>`~\r\n]/g, character => entities[character]);
        const collapsed = `<details><summary>${t('View full comment', '查看完整留言')}</summary>${encoded}</details>`;
        if (bytes(collapsed) > 64 * 1024) return [markdown(body, 6 * 1024)];
        const firstSourceBlock = body.replace(/^(?:[ \t]*(?:\r?\n|<!--[\s\S]*?-->))+/, '').split(/\r?\n[ \t]*\r?\n/)[0];
        const firstBlock = firstSourceBlock.trim();
        const heading = /^(?:#{1,6})[ \t]+([^\r\n]+?)(?:[ \t]+#+)?$/.exec(firstBlock.split(/\r?\n/)[0]);
        const summary = (heading ? heading[1] : firstBlock).replace(/<\/?span\b[^<>]*>/gi, '');
        const suitable = summary && !/^(?: {4}|\t)/.test(firstSourceBlock) && Array.from(summary).length <= 280 && bytes(summary) <= 1024
          && !/^(?:[ \t]*[<|>#`~]|[ \t]*[-*+]\s|[ \t]*\d+[.)]\s|!?\[[^\]]*\](?:\[[^\]]*\]|:))/.test(summary)
          && !/^!\[[^\]]*\]\(/.test(summary) && !tableDivider.test(summary)
          && !/<(?:details|summary|table|pre|script)\b|<\//i.test(summary);
        return [...(suitable ? [markdown(summary, 1024)] : []), node('markdown', { text: collapsed })];
      };
      const { sources, activity } = discussionActivity(model);
      const entries = groupedActivity(model, activity);
      const activityRow = ({ source, entry }, id) => {
        const event = source === 'timeline', created = date(entry), metadata = [], body = [];
        if (event) {
          const sha = entry.sha || entry.commit_id;
          const commit = /^[a-f\d]{40}$/i.test(sha || '') ? items(model, 'commits').find(value => value.sha?.toLowerCase() === sha.toLowerCase()) : null;
          const message = entry.event === 'committed' ? String(commit?.commit?.message || entry.message || '').split('\n')[0] : '';
          metadata.push(text(message ? short(message, 160) : eventLabel(entry)), node('spacer'));
          if (sha) {
            const url = /^[a-f\d]{40}$/i.test(sha) ? `https://github.com/${model.repo}/commit/${sha}` : prURL(model) + '/commits';
            metadata.push(button(short(sha, 8), openAction(url, prURL(model) + '/commits')));
          }
          if (created) metadata.push(text(created));
          if (entry.dismissed_review?.dismissal_message) body.push(markdown(entry.dismissed_review.dismissal_message, 2048));
        } else {
          if (created) metadata.push(text(created));
          if (source === 'reviews') metadata.push(reviewState(entry.state));
          metadata.push(node('spacer'), open(model, t('View comment on GitHub', '在 GitHub 查看留言'), entry.html_url, '', { appearance: 'icon' }));
          if (source === 'reviewComments') body.push(text([entry.path, Number.isInteger(entry.line || entry.original_line) ? t(`line ${entry.line || entry.original_line}`, `第 ${entry.line || entry.original_line} 行`) : '', entry.in_reply_to_id ? t(`Reply to #${entry.in_reply_to_id}`, `回复 #${entry.in_reply_to_id}`) : ''].filter(Boolean).join(' · '), 'monospaced'));
          if (entry.body) body.push(...commentBody(source, entry));
          else if (source === 'reviews') body.push(text(t('Review submitted without a message.', '已提交审查，没有附加留言。')));
        }
        return node('timelineItem', { id, value: event ? 'event' : 'comment' }, [
          authorButton(model, entry, prURL(model)), row(metadata), ...(body.length ? [column(body)] : []),
        ]);
      };
      const cards = entries.slice(-80).map((value, index) => {
        if (!value.entries) return activityRow(value, `pr-activity-${index}`);
        const expanded = model.expandedCommitGroups.has(value.key);
        const lastDate = relativeDate(value.entries.at(-1).entry);
        const header = nativeRow(t(`${value.entries.length} commits`, `${value.entries.length} 次提交`), '', {
          id: `pr-commit-group-header-${value.key}`, action: `pr-commits:${value.key}`, symbol: 'circle.and.line.horizontal', appearance: 'secondary', tone: 'muted',
          ...(supportsItemRowIcon ? { iconSVG: commitGroupIconSVG } : {}),
        }, lastDate ? [text(lastDate)] : []);
        const rows = expanded ? value.entries.map((entry, offset) => activityRow(entry, `pr-group-commit-${value.key}-${offset}`)) : [];
        const card = node('column', { id: `pr-commit-group-${value.key}` }, [header, ...rows]);
        if (expanded) commitGroupRows.set(card, { rows });
        return card;
      });
      const footer = sources.flatMap(([name, label]) => sectionState(model, name, label));
      if (entries.length > 80) footer.push(text(t('Showing part of the loaded history. View the full conversation on GitHub.', '这里只显示部分已加载记录，完整讨论可在 GitHub 查看。')));
      if (!hasDetailAside(model)) footer.push(nativeReadiness(model));
      footer.push(...nativeCommentComposer(model));
      const fitted = fit(model, hasDetailAside(model) ? [nativeDescription(model), node('divider'), text(t('Activity', '动态'), 'headline', 'neutral')] : [nativeDescription(model)], cards, footer, '', true, 1);
      const start = hasDetailAside(model) ? 3 : 0;
      const end = fitted.findIndex((value, index) => index >= start && (value.type !== 'timelineItem' && !value.id?.startsWith('pr-commit-group-') || value.id === 'pr-comment-composer'));
      const threadEnd = end < 0 ? fitted.length : end;
      return [...fitted.slice(0, start), node('column', { id: 'pr-conversation' }, fitted.slice(start, threadEnd)), ...fitted.slice(threadEnd)];
    }
    function nativeCommentComposer(model) {
      const children = commentActions(model).filter(value => value.type !== 'divider');
      if (!children.length) return [];
      if (supportsNativeTimeline) return [node('timelineItem', { id: 'pr-comment-composer', value: 'comment' }, [
        authorButton(model, { user: currentUser() || {} }, prURL(model)), row([text(t('Leave a comment', '留言')), node('spacer')]),
        column(children.filter(value => !(value.type === 'text' && value.textStyle === 'headline'))),
      ])];
      return [node('column', { id: 'pr-comment-composer', appearance: 'secondary' }, children)];
    }
    function nativeCommits(model) {
      const list = items(model, 'commits');
      const cards = list.slice(0, 80).map((commit, index) => {
        const message = String(commit.commit?.message || ''), lines = message.split('\n');
        if (supportsNativeTimeline) return node('timelineItem', { id: `pr-commit-${index}`, value: 'comment' }, [
          authorButton(model, commit, prURL(model) + '/commits'), row([text(date(commit)), node('spacer'), open(model, short(commit.sha, 8), commit.html_url, '/commits', { symbol: undefined })]),
          column([open(model, boundedText(lines[0] || t('Commit', '提交'), 512, '…'), commit.html_url, '/commits', { tone: 'neutral', symbol: undefined }),
            ...(lines.slice(1).join('\n').trim() ? [markdown(lines.slice(1).join('\n').trim(), 2048)] : [])]),
        ]);
        return node('column', { id: `pr-commit-${index}`, appearance: 'plain' }, [
          open(model, boundedText(lines[0] || t('Commit', '提交'), 512, '…'), commit.html_url, '/commits', { tone: 'neutral' }),
          row([authorButton(model, commit, prURL(model) + '/commits'), text(date(commit)), node('spacer'), open(model, short(commit.sha, 8), commit.html_url, '/commits')]),
          ...(lines.length > 1 && lines.slice(1).join('\n').trim() ? [markdown(lines.slice(1).join('\n').trim(), 2048)] : []),
        ]);
      });
      const header = !list.length && section(model, 'commits').loaded && !section(model, 'commits').error
        ? [text(t('No commits returned.', '暂无提交记录。'))] : [];
      return fit(model, header, cards, sectionState(model, 'commits', t('Commits', '提交')), '/commits');
    }
    function workflow(model, runs = headItems(model, 'workflows')) {
      const priority = new Set(['in_progress', 'failure', 'error', 'timed_out', 'action_required', 'pending', 'waiting', 'queued', 'requested']);
      return runs.find(entry => String(entry.id) === String(model.selectedRunID))
        || runs.find(entry => priority.has(String(entry.conclusion || entry.status || '').toLowerCase()))
        || runs.find(entry => /\bci\b/i.test(String(entry.name || entry.display_title || '')))
        || runs.find(entry => entry.conclusion !== 'skipped' && entry.status !== 'skipped') || runs[0];
    }
    function nativeActions(model, runs, controls) {
      const run = workflow(model, runs);
      const left = [...controls, ...sectionState(model, 'workflows', 'GitHub Actions')];
      const runState = section(model, 'workflows');
      if (!run) return node('splitView', { value: model.checksDetailVisible ? 'detail' : 'list', action: 'pr-ci-back', text: t('Checks', '检查') }, [column(left), column([
        node('emptyState', { text: runState.error ? t('Actions unavailable', '无法获取 Actions') : runState.loading ? t('Loading workflows…', '正在加载工作流…') : t('No workflow runs', '暂无工作流'),
          subtitle: runState.error ? short(runState.error, 512) : t('GitHub Actions will appear here when a workflow starts.', '工作流启动后，GitHub Actions 会显示在这里。'), symbol: runState.error ? 'exclamationmark.circle' : 'play.circle' }),
      ])]);
      const visibleRuns = selectedList(runs, run.id);
      left.push(node('menu', { text: short(run.name || run.display_title || 'GitHub Actions', 180), symbol: 'chevron.down' }, visibleRuns.map(entry => {
        const result = status(entry);
        return button(`${entry.name || entry.display_title || 'GitHub Actions'}${entry.run_number ? ` #${entry.run_number}` : ''}`, `pr-jobs:${entry.id}`, { symbol: result.symbol, tone: result.tone, value: String(entry.id) === String(run.id) ? 'selected' : '' });
      })), text([run.run_number ? `#${run.run_number}` : '', run.event, date(run)].filter(Boolean).join(' · ')), node('divider'));
      if (runs.length > visibleRuns.length) left.push(text(t('More workflows are available on GitHub.', '更多工作流可在 GitHub 查看。')));
      const state = model.jobsByRun?.[run.id];
      if (state?.loading) left.push(node('progress', { text: t('Loading jobs…', '正在加载任务…') }));
      if (state?.error) left.push(text(short(state.error, 512), 'caption', 'warning'), button(t('Retry jobs', '重试任务'), `pr-jobs:${run.id}`, { disabled: !!state.loading }));
      if (state?.notice) left.push(text(state.notice));
      const jobs = Array.isArray(state?.items) ? state.items : [], job = jobs.find(entry => String(entry.id) === String(model.selectedJobID)) || jobs[0];
      const visibleJobs = selectedList(jobs, job?.id);
      left.push(...visibleJobs.map(entry => resultRow(entry, entry.name || t('Job', '任务'), `pr-job:${entry.id}`, { value: String(entry.id) === String(job?.id) ? 'selected' : '' })));
      if (jobs.length > visibleJobs.length) left.push(text(t('Showing 30 loaded jobs. More are available on GitHub.', '显示 30 个已加载任务，更多任务可在 GitHub 查看。')));
      if (state?.nextPage) left.push(button(t('Load more jobs', '加载更多任务'), `pr-jobs:${run.id}`, { disabled: !!state.loading }));
      const right = [];
      if (!state) right.push(node('emptyState', { text: t('Explore this workflow', '查看工作流'), subtitle: short(run.name || 'GitHub Actions', 256), symbol: 'list.bullet.rectangle' }, [button(t('Load jobs & steps', '加载任务与步骤'), `pr-jobs:${run.id}`, { appearance: 'secondary', symbol: 'arrow.down.circle' })]));
      else if (!job) right.push(node('emptyState', { text: state.error ? t('Jobs unavailable', '无法获取任务') : state.loading ? t('Loading jobs…', '正在加载任务…') : t('No jobs reported', '暂无任务'),
        ...(state.error ? { subtitle: short(state.error, 512) } : {}), symbol: state.error ? 'exclamationmark.circle' : 'list.bullet.rectangle' }));
      else {
        const steps = Array.isArray(job.steps) ? job.steps : [], completed = steps.filter(step => step.status === 'completed').length;
        right.push(row([text(short(job.name || t('Job', '任务'), 512), 'headline', 'neutral'), node('spacer'), statusBadge(job), open(model, t('View job on GitHub', '在 GitHub 查看任务'), job.html_url, '/checks', { appearance: 'icon' })]),
          text([t(`${completed}/${steps.length} steps finished`, `${completed}/${steps.length} 个步骤已结束`), duration(job)].filter(Boolean).join(' · ')), node('divider'));
        right.push(column(steps.slice(0, 30).map(step => {
          const label = String(step.name || '').replace(/@[a-f\d]{40}\b/gi, '').replace(/^Run (?=[\w.-]+\/)/, '');
          return resultRow(step, `${step.number || ''} ${label}`.trim());
        })));
        if (steps.length > 30) right.push(text(t('Showing the first 30 steps. The complete step list is available on GitHub.', '显示前 30 个步骤，完整步骤可在 GitHub 查看。')));
        if (!steps.length) right.push(text(t('Step details are not available for this job.', '这个任务暂未提供步骤详情。')));
      }
      right.push(node('divider'), open(model, t('Workflow run on GitHub', '在 GitHub 查看运行记录'), run.html_url, '/checks'));
      return node('splitView', { id: 'pr-check-workspace', value: model.checksDetailVisible ? 'detail' : 'list', action: 'pr-ci-back', text: t('Checks', '检查') }, [column(left), column(right)]);
    }
    function nativeChecks(model) {
      const checks = headItems(model, 'checks'), statuses = headItems(model, 'statuses'), workflows = headItems(model, 'workflows');
      const sources = ['actions', 'checks', 'statuses'], source = sources.includes(model.checksSource) ? model.checksSource : workflows.length ? 'actions' : checks.length ? 'checks' : statuses.length ? 'statuses' : 'actions';
      const counts = { actions: workflows.length, checks: checks.length, statuses: statuses.length };
      const labels = { actions: 'Actions', checks: t('Checks', '检查项'), statuses: t('Statuses', '状态') };
      const controls = [node('menu', { id: 'pr-ci-sources', text: labels[source], symbol: source === 'actions' ? 'play.circle' : 'checklist' },
        sources.map(name => button(`${labels[name]}${counts[name] ? ` · ${counts[name]}` : ''}`, `pr-ci:${name}`, { ...(source === name ? { value: 'selected' } : {}) })))];
      if (source === 'actions') return [nativeActions(model, workflows, controls)];
      const list = source === 'checks' ? checks : statuses, selectedID = source === 'checks' ? model.selectedCheckID : model.selectedStatusID;
      const current = list.find(entry => String(entry.id) === String(selectedID)) || list[0], visible = selectedList(list, current?.id);
      const left = [...controls, ...visible.map(entry => resultRow(entry, entry.name || entry.context || t('Check', '检查'), `pr-${source === 'checks' ? 'check' : 'status'}:${entry.id}`, { value: String(entry.id) === String(current?.id) ? 'selected' : '' })),
        ...sectionState(model, source, labels[source])];
      if (list.length > visible.length) left.push(text(t('More reported checks are available on GitHub.', '更多检查记录可在 GitHub 查看。')));
      const sourceState = section(model, source);
      const right = current ? [row([text(current.name || current.context || t('Check', '检查'), 'headline', 'neutral'), node('spacer'), statusBadge(current)]),
        text([date(current), duration(current)].filter(Boolean).join(' · ')), node('divider'),
        ...(current.output?.title ? [text(current.output.title, 'body', 'neutral')] : []),
        ...(current.output?.summary ? [markdown(current.output.summary, 8 * 1024)] : []),
        ...(current.description ? [text(current.description, 'body', 'neutral')] : []),
        open(model, t('View on GitHub', '在 GitHub 查看'), current.details_url || current.html_url || current.target_url, '/checks')]
        : [node('emptyState', { text: sourceState.error ? t('Checks unavailable', '无法获取检查信息') : sourceState.loading ? t('Loading checks…', '正在加载检查…') : t('No checks reported', '暂无检查记录'),
          subtitle: sourceState.error ? short(sourceState.error, 512) : t('Reported results for this commit will appear here.', '这个提交的检查结果会显示在这里。'), symbol: sourceState.error ? 'exclamationmark.circle' : 'checklist' })];
      return [node('splitView', { id: 'pr-check-workspace', value: model.checksDetailVisible ? 'detail' : 'list', action: 'pr-ci-back', text: labels[source] }, [column(left), column(right)])];
    }
    const fileState = file => {
      const labels = { added: t('Added', '新增'), removed: t('Removed', '删除'), modified: t('Modified', '修改'), renamed: t('Renamed', '重命名'), copied: t('Copied', '复制'), changed: t('Changed', '变更'), unchanged: t('Unchanged', '未变更') };
      return { text: labels[file.status] || t('Changed', '变更'), tone: file.status === 'added' ? 'success' : file.status === 'removed' ? 'danger' : 'muted',
        symbol: { added: 'doc.badge.plus', removed: 'doc.badge.minus', renamed: 'arrow.right', copied: 'doc.on.doc' }[file.status] || 'doc.text' };
    };
    const fileCounts = file => [text(`+${Number.isInteger(file.additions) ? file.additions : 0}`, 'monospaced', 'success'), text(`−${Number.isInteger(file.deletions) ? file.deletions : 0}`, 'monospaced', 'danger')];
    function nativeFiles(model) {
      const list = items(model, 'files'), state = section(model, 'files');
      const selected = list.find(file => file.filename === model.selectedFileID) || list[0];
      const left = [row([text(t('Changed files', '文件变更'), 'headline', 'neutral'), node('spacer'), text(`${list.length}${state.nextPage ? '+' : ''}`, 'monospaced')])];
      const totals = [
        ...(Number.isInteger(model.item?.additions) ? [node('badge', { text: `+${model.item.additions}`, tone: 'success', appearance: 'plain' })] : []),
        ...(Number.isInteger(model.item?.deletions) ? [node('badge', { text: `−${model.item.deletions}`, tone: 'danger', appearance: 'plain' })] : []),
      ];
      if (totals.length) left.push(node('row', { id: 'pr-file-totals' }, totals));
      left.push(...list.map((file, index) => {
        const path = String(file.filename || t('File', '文件')), slash = path.lastIndexOf('/'), result = fileState(file);
        return nativeRow(boundedText(path.slice(slash + 1), 128, '…'), slash >= 0 ? boundedText(path.slice(0, slash), 192, '…') : '',
          { action: `pr-file:${index}`, symbol: result.symbol, tone: result.tone, ...(file === selected ? { value: 'selected' } : {}) }, [row(fileCounts(file))]);
      }), ...sectionState(model, 'files', t('Files', '文件')));
      const right = [];
      if (!selected) right.push(node('emptyState', { text: state.error ? t('Files unavailable', '无法获取文件') : state.loading || !state.loaded ? t('Loading changed files…', '正在加载变更文件…') : t('No changed files', '暂无文件变更'),
        subtitle: state.error ? short(state.error, 512) : t('Select a changed file to review its diff.', '选择变更文件即可查看差异。'), symbol: state.error ? 'exclamationmark.circle' : 'doc.text' }));
      else {
        const result = fileState(selected), path = String(selected.filename || ''), source = typeof selected.patch === 'string' ? selected.patch : '';
        const fileHeader = row([text(path || t('File', '文件'), 'monospaced', 'neutral'), node('spacer'), badge(result.text, result.tone), ...fileCounts(selected),
          open(model, t('View file on GitHub', '在 GitHub 查看文件'), selected.blob_url, '/files', { appearance: 'icon' })]);
        if (selected.previous_filename) right.push(text(t(`Previously ${selected.previous_filename}`, `原文件名 · ${selected.previous_filename}`), 'monospaced'));
        const safePath = path.length > 0 && bytes(path) <= 4096 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path);
        if (!safePath) right.push(node('emptyState', { text: t('Preview unavailable', '无法预览'), subtitle: t('This file name cannot be shown in the native diff viewer. View the file on GitHub.', '此文件名无法在原生差异视图中显示，请在 GitHub 查看。'), symbol: 'doc.text' }));
        else if (!source) right.push(node('emptyState', { text: t('No text diff provided', '未提供文本差异'), subtitle: t('GitHub did not return a text patch. The file may be binary, too large, or renamed without content changes.', 'GitHub 未返回文本差异；文件可能为二进制、过大，或仅重命名而没有内容变化。'), symbol: 'doc.text' }));
        else {
          let patch = source;
          if (bytes(source) > 64 * 1024) {
            const prefix = boundedText(source, 64 * 1024);
            patch = prefix.slice(0, prefix.lastIndexOf('\n') + 1);
            right.push(text(t('Preview shortened to complete lines within 64 KiB. View the full diff on GitHub.', '预览仅保留 64 KiB 内的完整行，完整差异请在 GitHub 查看。'), 'caption', 'warning'));
          }
          let additions = 0, deletions = 0, inHunk = false;
          for (const line of source.split('\n')) {
            if (line.startsWith('@@ ')) { inHunk = true; continue; }
            if (!inHunk) continue;
            if (line.startsWith('+')) additions++;
            else if (line.startsWith('-')) deletions++;
          }
          if (Number.isInteger(selected.additions) && additions < selected.additions || Number.isInteger(selected.deletions) && deletions < selected.deletions) {
            right.push(text(t('GitHub returned only part of this file’s diff. View the complete change on GitHub.', 'GitHub 仅返回了此文件的部分差异，完整变更请在 GitHub 查看。'), 'caption', 'warning'));
          }
          if (patch) right.push(fileHeader, node('diff', { id: `pr-file-diff-${list.indexOf(selected)}`, text: patch, subtitle: path, value: 'unified' }));
          else right.push(node('emptyState', { text: t('Diff exceeds the preview limit', '差异超出预览范围'), subtitle: t('A complete diff line exceeds 64 KiB. View this file on GitHub.', '一行差异已超过 64 KiB，请在 GitHub 查看此文件。'), symbol: 'doc.text' }));
        }
        if (!right.some(value => value.type === 'diff')) right.unshift(fileHeader);
      }
      return [node('splitView', { id: 'pr-file-workspace', value: model.filesDetailVisible ? 'detail' : 'list', action: 'pr-files-back', text: t('Files', '文件') }, [column(left), column(right)])];
    }
    function nativeContent(model) {
      let body;
      if (model.tab === 'checks') body = nativeChecks(model);
      else if (model.tab === 'commits') body = nativeCommits(model);
      else if (model.tab === 'files') body = supportsNativeDiff ? nativeFiles(model) : filesView(model);
      else body = nativeDiscussion(model);
      if (model.mergeExpanded || model.merge?.pending) body.unshift(node('column', { id: 'pr-merge-options', appearance: 'secondary' }, mergeActions(model)));
      return body;
    }
    return { summary, content, actions, tabs, nativeContent, nativeDescription, nativeAside, toggleCommitGroup, workflow, supportsNativeLayout };
  }
  const panelID = 'com.nora.github.panel';
  const clientID = 'Iv23liPZy7EARoSnYoYy';
  const connectionKey = 'connection';
  const pullRequestIcons = {
    open: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Huge Icons by Hugeicons - undefined --><g fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 8v8m12 0v-4c0-2.828 0-4.243-.879-5.121C16.243 6 14.828 6 12 6h-1m0 0c0-.7 1.994-2.008 2.5-2.5M11 6c0 .7 1.994 2.008 2.5 2.5"/><circle cx="6" cy="18" r="2"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/></g></svg>',
    draft: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Huge Icons by Hugeicons - undefined --><g fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 8v8"/><circle cx="6" cy="18" r="2"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path stroke-linecap="round" d="M18.125 11H18m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0Zm-.125-5H18m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0Z"/></g></svg>',
    closed: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Huge Icons by Hugeicons - undefined --><g fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 8v8m12-5v5"/><circle cx="6" cy="18" r="2"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path stroke-linecap="round" stroke-linejoin="round" d="m20 4l-2 2m0 0l-2 2m2-2l2 2m-2-2l-2-2"/></g></svg>',
    merged: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Huge Icons by Hugeicons - undefined --><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 20a2 2 0 1 0 0-4a2 2 0 0 0 0 4ZM7 8a2 2 0 1 0 0-4a2 2 0 0 0 0 4Zm10 6a2 2 0 1 0 0-4a2 2 0 0 0 0 4Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M7.021 8.28v7.127m7.39-3.402H10.02c-1.097 0-3.157-.88-3-3.225"/></g></svg>',
  };
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
  const state = { user: null, avatarBase64: null, avatarAccount: '', avatarURL: '', repos: [], repo: '', repoQuery: '', items: [], kind: 'issues', status: 'open', query: '', author: '', label: '', page: 1, repoPage: 1, moreItems: false, moreRepos: false, selected: null, detailsVisible: false, detailLoading: false, detailError: '', device: null, error: '', itemLoadError: '', itemRetryAppend: false, restored: false, showToken: false, showOtherRepository: false, manualRepository: '', itemsLoading: false, reposLoading: false };
  const avatars = new Map();
  let participantButtons = new WeakMap();
  let visibleParticipants = new Map();
  let visibleParticipantPage = '';
  let participantCommitsOperation = null;
  const ownerAvatarWaiters = [];
  let activeOwnerAvatars = 0;
  const maximumSidebarItems = 400;
  let generation = 0;
  let itemRevision = 0;
  let detailRevision = 0;
  let repoRevision = 0;
  let refreshOperation = null;
  let avatarOperation = null;
  let panelInvalidation = null;
  let restoreOperation = null;
  const supportsPanelInvalidation = typeof nora.panels?.invalidate === 'function';
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
  async function http(url, { method = 'GET', headers = {}, body, responseEncoding, maximumResponseBytes, timeoutSeconds } = {}) {
    let response;
    try { response = await nora.request('network.request', { url, method, headers, ...(body === undefined ? {} : { body }),
      ...(responseEncoding === undefined ? {} : { responseEncoding }),
      ...(maximumResponseBytes === undefined ? {} : { maximumResponseBytes }),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) }); }
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
  async function api(path, token, options = {}) {
    const current = generation;
    const connection = token ? { token } : await activeCredentials();
    if (current !== generation) throw connectionChanged();
    const method = options.method || 'GET';
    let response;
    try {
      response = await http(`https://api.github.com${path}`, { method, timeoutSeconds: 12,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${connection.token}`, 'X-GitHub-Api-Version': '2026-03-10',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    } catch (error) {
      if (method !== 'GET') error.uncertain = true;
      throw error;
    }
    if (current !== generation) throw connectionChanged();
    let errorMessage;
    if (response.status === 401) errorMessage = message.expired;
    else if (response.status === 429 || response.status === 403 && (response.headers?.['x-ratelimit-remaining'] === '0' || response.headers?.['retry-after'])) errorMessage = t('GitHub rate limit reached. Try again later.', 'GitHub 请求次数已达上限，请稍后重试。');
    else if (response.status === 403) errorMessage = message.denied + t(' The GitHub App must also allow this operation.', ' GitHub App 也需要允许此操作。');
    else if (response.status === 404) errorMessage = t('Repository not found or not authorized.', '找不到仓库或尚未授权。');
    else if (response.status === 405) errorMessage = t('GitHub cannot merge this PR. Check its reviews, checks, conflicts, and merge queue on GitHub.', 'GitHub 暂时无法合并此 PR，请检查审查、检查结果、冲突和合并队列。');
    else if (response.status === 409) errorMessage = t('The PR changed. Refresh and confirm the latest commit before merging.', 'PR 已发生变化，请刷新后确认最新提交再合并。');
    else if (response.status === 410) errorMessage = t('GitHub no longer allows comments on this item.', 'GitHub 已不允许在此条目中发表评论。');
    else if (response.status === 422) errorMessage = t('GitHub rejected the request. Check the content and repository rules before trying again.', 'GitHub 拒绝了请求，请检查内容和仓库规则。');
    else if (!(options.expectedStatuses || [200]).includes(response.status)) errorMessage = message.network;
    if (errorMessage) {
      const error = new Error(errorMessage);
      error.status = response.status;
      throw error;
    }
    return { data: json(response), headers: response.headers || {}, status: response.status };
  }
  const writeAPI = (path, method, body) => {
    if (!['POST', 'PUT'].includes(method)) throw new Error(message.invalid);
    return api(path, undefined, { method, body, expectedStatuses: method === 'POST' ? [201] : [200] });
  };
  function repository(value) {
    if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error(t('Enter a repository as owner/name.', '请输入 owner/name 格式的仓库。'));
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
  function itemRepository(item) {
    return repository(item?.repository?.full_name);
  }
  const itemKey = item => `item-${itemRepository(item)}/${item.number}`;
  function normalizeItem(item, knownRepository = '') {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.number) || item.number < 1) throw new Error(message.invalid);
    let providedRepository = '';
    if (item.repository?.full_name !== undefined) providedRepository = repository(item.repository.full_name);
    if (item.repository_url !== undefined) {
      if (typeof item.repository_url !== 'string') throw new Error(message.invalid);
      const match = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(item.repository_url);
      if (!match) throw new Error(message.invalid);
      const urlRepository = repository(match[1]);
      if (providedRepository && providedRepository.toLowerCase() !== urlRepository.toLowerCase()) throw new Error(message.invalid);
      providedRepository = urlRepository;
    }
    if (knownRepository && providedRepository && knownRepository.toLowerCase() !== providedRepository.toLowerCase()) throw new Error(message.invalid);
    const repo = knownRepository || providedRepository;
    if (!repo) throw new Error(message.invalid);
    return { ...item, repository: { ...item.repository, full_name: repo } };
  }
  const uniqueItems = items => [...new Map(items.map(item => [itemKey(item), item])).values()];
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
  async function panelItems(repo, kind, filter, p) {
    if (repo) {
      const result = await listItems({ repository: repo, state: filter, page: p }, kind);
      return { ...result, items: result.items.map(item => normalizeItem(item, repo)) };
    }
    const result = await api(`/issues?filter=all&state=${filter}&sort=updated&direction=desc&per_page=50&page=${p}`);
    if (!Array.isArray(result.data)) throw new Error(message.invalid);
    const items = result.data.map(item => normalizeItem(item));
    return { items: items.filter(item => Boolean(item.pull_request) === (kind === 'pulls')),
      nextPage: hasNext(result.headers) ? p + 1 : null };
  }
  function clearDetails() {
    ++detailRevision;
    pullDetails.reset();
    state.selected = null; state.detailsVisible = false; state.detailLoading = false; state.detailError = '';
  }
  async function loadDetail(item, { preserveTab = false } = {}) {
    const revision = ++detailRevision, current = generation;
    const requestedKey = itemKey(item), requestedKind = state.kind, requestedRepo = state.repo, requestedStatus = state.status;
    state.selected = item; state.detailsVisible = true; state.detailLoading = true; state.detailError = '';
    const isCurrent = () => current === generation && revision === detailRevision && state.kind === requestedKind &&
      state.repo === requestedRepo && state.status === requestedStatus && state.selected && itemKey(state.selected) === requestedKey && state.detailsVisible;
    try {
      const result = await api(`/repos/${itemRepository(item)}/${requestedKind}/${item.number}`);
      if (!isCurrent()) return;
      const detail = normalizeItem(result.data, itemRepository(item));
      if (detail.number !== item.number || requestedKind === 'issues' && detail.pull_request) throw new Error(message.invalid);
      state.selected = { ...item, ...detail, id: item.id, repository: item.repository };
      state.items = state.items.map(loaded => itemKey(loaded) === requestedKey ? state.selected : loaded);
      if (requestedKind === 'pulls') await pullDetails.open(state.selected, { preserveTab });
      else pullDetails.reset();
    } catch (error) {
      if (isCurrent()) state.detailError = error?.message || message.network;
    } finally {
      if (isCurrent()) state.detailLoading = false;
    }
  }
  function findSelectedItem(value) {
    if (typeof value !== 'string') return null;
    const items = filteredItems();
    const exact = items.find(item => itemKey(item) === value);
    if (exact) return exact;
    const numeric = value.replace(/^item-/, '');
    if (!/^[1-9][0-9]*$/.test(numeric)) return null;
    const matches = items.filter(item => item.number === Number(numeric));
    return matches.length === 1 ? matches[0] : null;
  }
  async function loadItems(append = false, retry = false) {
    if (append && (state.itemsLoading || !state.moreItems || !retry && (state.itemLoadError || state.query.trim() || state.author || state.label || filteredItems().length >= maximumSidebarItems))) return;
    const revision = ++itemRevision, current = generation;
    const requestedRepo = state.repo, requestedKind = state.kind, requestedStatus = state.status;
    const requestedPage = append ? state.page + 1 : 1;
    if (!append) { state.items = []; clearDetails(); state.moreItems = false; }
    state.itemsLoading = true; state.itemLoadError = ''; state.itemRetryAppend = false;
    try {
      const result = await panelItems(requestedRepo, requestedKind, requestedStatus, requestedPage);
      if (current !== generation || revision !== itemRevision) return;
      state.page = requestedPage;
      state.items = uniqueItems(append ? [...state.items, ...result.items] : result.items);
      state.moreItems = !!result.nextPage;
      if (state.selected && !state.items.some(item => itemKey(item) === itemKey(state.selected))) clearDetails();
    } catch (error) {
      if (current !== generation || revision !== itemRevision) return;
      state.error = error?.message || message.network;
      state.itemLoadError = state.error; state.itemRetryAppend = append;
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
      return current === generation && revision === repoRevision;
    } catch (error) {
      if (current !== generation || revision !== repoRevision) return false;
      state.error = error?.message || message.network;
      throw error;
    } finally {
      if (current === generation && revision === repoRevision) state.reposLoading = false;
    }
  }
  function avatarURL(value) {
    if (typeof value !== 'string' || value.length > 8192 || /[\\\s\x00-\x1f\x7f]/.test(value)) return '';
    const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/i.exec(value);
    if (!match || !['avatars.githubusercontent.com', 'avatars.githubusercontent.com:443'].includes(match[1].toLowerCase())) return '';
    const query = [];
    for (const parameter of (match[3] || '').split('&')) {
      if (!parameter) continue;
      let key;
      try { key = decodeURIComponent(parameter.split('=')[0]); } catch { return ''; }
      if (key.toLowerCase() !== 's') query.push(parameter);
    }
    query.push('s=64');
    return `https://avatars.githubusercontent.com${match[2] || '/'}?${query.join('&')}`;
  }
  function invalidatePanel(current = generation, user = state.user) {
    if (!supportsPanelInvalidation || current !== generation || state.user !== user) return;
    if (panelInvalidation?.generation === current) { panelInvalidation.again = true; return; }
    const operation = { generation: current, again: false };
    panelInvalidation = operation;
    Promise.resolve().then(async () => {
      if (current !== generation || state.user !== user || panelInvalidation !== operation) return;
      await nora.panels.invalidate(panelID);
    }).catch(() => {
      // Earlier hosts keep the cached images for the next user-driven render.
    }).finally(() => {
      if (panelInvalidation !== operation) return;
      panelInvalidation = null;
      if (operation.again) invalidatePanel(current, user);
    });
  }
  async function loadAvatar() {
    const current = generation, user = state.user;
    if (!user) return;
    const account = `${user.id ?? ''}:${user.login}`, url = avatarURL(user.avatar_url);
    if (state.avatarAccount === account && state.avatarURL === url) return avatarOperation?.promise;
    state.avatarAccount = account; state.avatarURL = url; state.avatarBase64 = null;
    if (!url) return;
    const operation = { promise: null };
    avatarOperation = operation;
    operation.promise = (async () => {
      try {
        const response = await http(url, { headers: { Accept: 'image/png,image/jpeg' }, responseEncoding: 'base64',
          maximumResponseBytes: 96 * 1024, timeoutSeconds: 8 });
        if (current !== generation || state.user !== user || state.avatarAccount !== account || state.avatarURL !== url || avatarOperation !== operation) return;
        const contentType = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
        if (response.status !== 200 || typeof contentType !== 'string' || !['image/png', 'image/jpeg'].includes(contentType.split(';')[0].trim().toLowerCase()) ||
            typeof response.bodyBase64 !== 'string' || !response.bodyBase64) return;
        const validated = node('menu', { text: user.login, avatarBase64: response.bodyBase64 });
        state.avatarBase64 = validated.avatarBase64 || null;
        const owner = avatars.get(avatarKey({ owner: user.login.toLowerCase(), url }));
        if (owner) owner.base64 = state.avatarBase64;
        invalidatePanel(current, user);
      } catch {
        // Account navigation remains usable when the optional public avatar is unavailable.
      } finally {
        if (avatarOperation === operation) avatarOperation = null;
      }
    })();
    return operation.promise;
  }
  function ownerAvatarSource(item) {
    const name = itemRepository(item), owner = name.split('/')[0];
    const repositories = state.repos.filter(repo => typeof repo.full_name === 'string' &&
      repo.full_name.split('/')[0].toLowerCase() === owner.toLowerCase());
    const owners = [repositories.find(repo => repo.full_name.toLowerCase() === name.toLowerCase())?.owner,
      ...repositories.map(repo => repo.owner), item.repository?.owner];
    for (const account of owners) {
      if (!account || typeof account.login === 'string' && account.login.toLowerCase() !== owner.toLowerCase()) continue;
      const url = avatarURL(account.avatar_url);
      if (url) return { owner: owner.toLowerCase(), url };
    }
    if (state.user?.login.toLowerCase() === owner.toLowerCase() && state.avatarURL) {
      return { owner: owner.toLowerCase(), url: state.avatarURL, accountAvatar: true };
    }
    return { owner: owner.toLowerCase(), url: `https://avatars.githubusercontent.com/${owner}?s=64` };
  }
  async function withOwnerAvatarSlot(operation) {
    if (activeOwnerAvatars === 4) await new Promise(resolve => ownerAvatarWaiters.push(resolve));
    else activeOwnerAvatars++;
    try { return await operation(); }
    finally {
      const next = ownerAvatarWaiters.shift();
      if (next) next();
      else activeOwnerAvatars--;
    }
  }
  const avatarKey = source => `${source.owner}|${source.url}`;
  const cachedAvatar = source => avatars.get(avatarKey(source));
  function participantSource(account) {
    const login = account?.login;
    if (typeof login !== 'string' || !/^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i.test(login)) return null;
    const owner = login.toLowerCase(), suppliedURL = avatarURL(account.avatar_url);
    const currentAccount = state.user?.login.toLowerCase() === owner;
    const known = [...avatars.values()].filter(entry => entry.owner === owner);
    const existing = known.find(entry => entry.base64) || known[0];
    const url = suppliedURL || (currentAccount && state.avatarURL) || existing?.url || `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=64`;
    return { owner, url, accountAvatar: currentAccount && url === state.avatarURL };
  }
  function participantPage() {
    if (!state.user || !state.selected || !state.detailsVisible || state.detailLoading || state.detailError || state.showOtherRepository) return '';
    return `${generation}:${detailRevision}:${state.kind}:${itemKey(state.selected)}:${state.kind === 'pulls' ? pullDetails.current?.tab || '' : ''}`;
  }
  function avatarIsVisible(source) {
    if (visibleParticipantPage && visibleParticipantPage === participantPage() && visibleParticipants.has(avatarKey(source))) return true;
    const item = filteredItems().slice(0, maximumSidebarItems).find(value => itemRepository(value).split('/')[0].toLowerCase() === source.owner);
    return !!item && ownerAvatarSource(item).url === source.url;
  }
  async function loadSmallAvatar(source) {
    const current = generation, user = state.user;
    if (!user) return;
    const key = avatarKey(source), cached = avatars.get(key);
    if (cached) return cached.promise;
    if (avatars.size >= 512) {
      for (const [candidate, entry] of avatars) {
        if (!entry.promise) { avatars.delete(candidate); break; }
      }
      if (avatars.size >= 512) return;
    }
    const entry = { owner: source.owner, url: source.url, base64: null, promise: null };
    avatars.set(key, entry);
    if (source.accountAvatar) { entry.base64 = state.avatarBase64; return; }
    entry.promise = withOwnerAvatarSlot(async () => {
      try {
        if (current !== generation || state.user !== user || avatars.get(key) !== entry) return;
        if (!avatarIsVisible(source)) { avatars.delete(key); return; }
        const response = await http(source.url, { headers: { Accept: 'image/png,image/jpeg' }, responseEncoding: 'base64',
          maximumResponseBytes: 8 * 1024, timeoutSeconds: 3 });
        if (current !== generation || state.user !== user || avatars.get(key) !== entry) return;
        const contentType = Object.entries(response.headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
        if (response.status !== 200 || typeof contentType !== 'string' || !['image/png', 'image/jpeg'].includes(contentType.split(';')[0].trim().toLowerCase()) ||
            typeof response.bodyBase64 !== 'string' || !response.bodyBase64 || response.bodyBase64.length > Math.ceil(8 * 1024 / 3) * 4) return;
        const validated = node('navigationItem', { avatarBase64: response.bodyBase64 });
        const padding = response.bodyBase64.endsWith('==') ? 2 : response.bodyBase64.endsWith('=') ? 1 : 0;
        if (response.bodyBase64.length / 4 * 3 - padding > 8 * 1024) return;
        entry.base64 = validated.avatarBase64 || null;
        if (avatarIsVisible(source)) invalidatePanel(current, user);
      } catch {
        // Optional images cannot block work items; failures are cached until the source changes or the account is reset.
      } finally { entry.promise = null; }
    });
    return entry.promise;
  }
  async function loadAvatarSources(sources, isCurrent = () => true) {
    const current = generation, user = state.user;
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
      while (index < sources.length && current === generation && state.user === user && isCurrent()) await loadSmallAvatar(sources[index++]);
    }));
  }
  async function loadOwnerAvatars() {
    if (!state.user) return;
    const sources = [...new Map(filteredItems().slice(0, maximumSidebarItems).map(item => {
      const source = ownerAvatarSource(item);
      return [source.owner, source];
    })).values()].filter(source => !cachedAvatar(source) || cachedAvatar(source).promise).slice(0, 16);
    await loadAvatarSources(sources);
  }
  async function loadParticipantAvatars() {
    const page = visibleParticipantPage;
    if (!page || page !== participantPage()) return;
    await loadAvatarSources([...visibleParticipants.values()].slice(0, 64), () => page === participantPage());
  }
  function retryFailedAvatars() {
    for (const [key, entry] of avatars) if (!entry.base64 && !entry.promise) avatars.delete(key);
    if (state.user && !state.avatarBase64 && !avatarOperation) {
      state.avatarAccount = '';
      void loadAvatar();
    }
  }
  function clearAccount() {
    state.user = null; state.repos = []; state.repo = ''; state.items = []; state.selected = null; state.device = null;
    state.avatarBase64 = null; state.avatarAccount = ''; state.avatarURL = ''; avatarOperation = null;
    panelInvalidation = null;
    restoreOperation = null;
    avatars.clear(); visibleParticipants.clear(); visibleParticipantPage = ''; participantButtons = new WeakMap(); participantCommitsOperation = null;
    state.itemLoadError = ''; state.itemRetryAppend = false;
    state.moreItems = false; state.moreRepos = false;
    state.page = 1; state.repoPage = 1; state.query = ''; state.repoQuery = ''; state.author = ''; state.label = ''; state.kind = 'issues'; state.status = 'open';
    clearDetails(); state.showToken = false; state.showOtherRepository = false;
    state.manualRepository = ''; state.itemsLoading = false; state.reposLoading = false;
    ++itemRevision; ++repoRevision;
  }
  async function restore() {
    if (state.restored) return;
    state.restored = true;
    const current = generation;
    if (!await readSaved()) return;
    if (current !== generation) return;
    const result = await api('/user');
    if (current !== generation) return;
    if (!result.data || typeof result.data.login !== 'string' || !result.data.login) throw new Error(message.invalid);
    state.user = result.data;
    await loadAccountData();
  }
  async function loadAccountData() {
    void loadAvatar();
    const results = await Promise.allSettled([loadRepositories(), loadItems()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  function startRestore() {
    if (restoreOperation?.generation === generation) return;
    const current = generation, operation = { generation: current };
    restoreOperation = operation;
    operation.promise = restore().catch(error => {
      if (current === generation && restoreOperation === operation) state.error = error?.message || message.network;
    }).finally(() => {
      if (restoreOperation !== operation) return;
      restoreOperation = null;
      invalidatePanel(current, state.user);
    });
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
    await loadAccountData();
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
    await loadAccountData();
  }
  function itemStatus(item) {
    const isPullRequest = state.kind === 'pulls';
    if (item.merged === true || item.merged_at || item.pull_request?.merged_at) return { text: t('Merged', '已合并'), symbol: 'arrow.triangle.merge',
      tone: nora.features?.purpleTone === true ? 'purple' : 'accent', iconSVG: pullRequestIcons.merged };
    if (item.state === 'closed') return { text: t('Closed', '已关闭'), symbol: isPullRequest ? 'xmark.circle' : 'checkmark.circle', tone: isPullRequest ? 'danger' : 'accent',
      ...(isPullRequest ? { iconSVG: pullRequestIcons.closed } : {}) };
    if (item.draft) return { text: t('Draft', '草稿'), symbol: 'circle.dashed', tone: 'muted',
      ...(isPullRequest ? { iconSVG: pullRequestIcons.draft } : {}) };
    return { text: t('Open', '打开'), symbol: isPullRequest ? 'arrow.triangle.pull' : 'circle.circle', tone: 'success',
      ...(isPullRequest ? { iconSVG: pullRequestIcons.open } : {}) };
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
    return state.items.filter(item => (!query || `${itemRepository(item)} ${item.number} ${item.title} ${item.user?.login || ''}`.toLowerCase().includes(query))
      && (!state.author || item.user?.login === state.author) && (!state.label || itemLabels(item).includes(state.label)));
  }
  function clearHiddenSelection() {
    if (state.selected && !filteredItems().some(item => itemKey(item) === itemKey(state.selected))) clearDetails();
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
  function encodedViewSize(descriptor) {
    const normalized = item => ({ ...item, options: item.options || [], disabled: item.disabled || false,
      children: (item.children || []).map(normalized), items: (item.items || []).map(normalized) });
    // Swift encodes decoded defaults and escapes slashes, including those inside inline Base64 images.
    return utf8Size(JSON.stringify(normalized(descriptor)).replace(/\//g, '\\/'));
  }
  const viewNodeCount = descriptor => 1 + (descriptor.children || []).reduce((count, child) => count + viewNodeCount(child), 0)
    + (descriptor.items || []).reduce((count, child) => count + viewNodeCount(child), 0);
  function draftForSelectedItem() {
    const item = state.selected;
    if (!item || !state.detailsVisible) throw new Error(t('Select an item to hand to Nora.', '选择一条条目后才能交给 Nora。'));
    if (state.detailLoading || state.detailError) throw new Error(t('Load this item’s details before handing it to Nora.', '请先加载条目详情，再交给 Nora。'));
    const kind = state.kind === 'pulls' ? 'PR' : 'Issue';
    const sourceURL = githubURL(item.html_url);
    const body = typeof item.body === 'string' && item.body ? item.body : t('No description.', '暂无描述。');
    const context = [t('GitHub source', 'GitHub 来源'),
      `${t('Repository', '仓库')}: ${itemRepository(item)}`, `${t('Type', '类型')}: ${kind}`, `${t('Number', '编号')}: #${item.number}`,
      `${t('Title', '标题')}: ${short(item.title, 4096)}`, `${t('State', '状态')}: ${itemStatus(item).text}`,
      `${t('Author', '作者')}: ${short(item.user?.login || t('Unknown author', '未知作者'), 64)}`,
      `${t('URL', '链接')}: ${sourceURL}`,
      ...(state.kind === 'pulls' ? ['', pullDetails.context()] : []), '', `${t('Description', '描述')}:`, body].join('\n');
    return { title: boundedText(`${kind} #${item.number} · ${item.title}`, 256),
      prompt: t(`Please help me analyze and work on this GitHub ${kind}.`, `请帮我分析并处理这条 GitHub ${kind}。`),
      context: boundedText(context, 128 * 1024, '\n\n' + t('Description shortened. The full text is available at the GitHub source URL.', '描述已截断，GitHub 来源链接中保留完整内容。')),
      sourceURL };
  }
  function connectionView() {
    const children = state.error ? [node('badge', { text: state.error, tone: 'danger' })] : [];
    if (state.device) {
      children.push(node('column', { id: 'github-device-code', appearance: 'secondary' }, [
        styledText(t('Your verification code', '你的验证码')),
        styledText(state.device.userCode, 'monospaced', 'neutral'),
      ]), row([button(t('Open GitHub', '打开 GitHub'), 'open-login', false, { appearance: 'secondary', symbol: 'arrow.up.forward.square' }),
        button(t('Finish sign-in', '完成登录'), 'finish-login', false, { appearance: 'primary' })]),
        styledText(t('Confirm in your browser, then choose Finish sign-in.', '在浏览器确认授权后，点击“完成登录”。')),
        button(t('Cancel', '取消'), 'cancel-login', false, { appearance: 'plain' }));
    } else {
      children.push(button(message.signIn, 'begin-login', false, { appearance: 'primary', symbol: 'person.crop.circle' }));
      if (state.error) children.push(button(t('Try again', '重试'), 'retry-load'));
      children.push(button(state.showToken ? t('Hide access token', '收起访问 token') : t('Use an access token', '使用访问 token'), 'toggle-token', false, { appearance: 'plain' }));
      if (state.showToken) children.push(node('column', { id: 'github-token-form', appearance: 'secondary' }, [
        node('secureField', { id: 'token', placeholder: t('GitHub access token', 'GitHub 访问 token') }),
        button(t('Connect with token', '使用 token 连接'), 'connect-token', false, { appearance: 'secondary' }),
      ]));
      children.push(button(message.manage, 'manage', false, { appearance: 'plain', symbol: 'folder.badge.gearshape' }),
        styledText(t('Nora stores your account credentials locally on this Mac.', 'Nora 将账号凭据保存在这台 Mac 本地。')));
    }
    return node('emptyState', { id: 'connection', text: state.device ? t('Finish connecting GitHub', '完成 GitHub 连接') : message.connect,
      subtitle: state.device ? t('Enter this code on GitHub to authorize your account.', '在 GitHub 输入验证码，为你自己的账号授权。')
        : t('Connect your own account to browse repositories, Issues, and pull requests.', '连接你自己的账号，查看仓库、Issues 和 PR。'),
      symbol: 'person.crop.circle' }, children);
  }
  function accountMenu() {
    const children = [button(t('Open another repository…', '打开其他仓库…'), 'show-other-repo', false, { symbol: 'plus' }),
      button(message.manage, 'manage', false, { symbol: 'folder.badge.gearshape' }),
      button(t('Refresh repositories', '刷新仓库'), 'refresh-repos', state.reposLoading, { symbol: 'arrow.clockwise' }), node('divider'),
      button(t('Disconnect', '断开连接'), 'disconnect', false, { symbol: 'rectangle.portrait.and.arrow.right' })];
    if (state.moreRepos) children.splice(3, 0, button(t('Load more repositories', '加载更多仓库'), 'more-repos', state.reposLoading, { symbol: 'arrow.down.circle' }));
    return node('menu', { text: state.user.login, tone: 'neutral', symbol: 'person.crop.circle',
      ...(state.avatarBase64 ? { avatarBase64: state.avatarBase64 } : {}) }, children);
  }
  function repositoryPicker() {
    const recent = [...new Set(state.repos.map(repo => repo.full_name)
      .filter(name => typeof name === 'string' && name && name.length <= 200))].slice(-100);
    const names = [...new Set([state.repo, ...recent].filter(Boolean))].slice(0, 100);
    return node('picker', { id: 'repository', text: t('Repository', '仓库'), action: 'repository', value: state.repo,
      options: [{ value: '', text: t('All repositories', '所有仓库') }, ...names.map(value => ({ value, text: value }))] });
  }
  function feedToken() {
    let hash = 2166136261;
    for (const character of JSON.stringify([state.repo, state.kind, state.status, state.query, state.author, state.label])) {
      hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
    }
    return `${generation}:${itemRevision}:${state.page}:${hash >>> 0}`;
  }
  function itemSidebar(visibleItems, totalItems, avatarCount = visibleItems.length) {
    const children = [accountMenu(),
      node('sidebar', { id: 'view-navigation', value: `view-${state.kind}`, items: [
        node('navigationItem', { id: 'view-issues', text: 'Issues', symbol: 'circle.circle', action: 'kind:issues' }),
        node('navigationItem', { id: 'view-pulls', text: t('Pull requests', 'PR'), symbol: 'arrow.triangle.pull', action: 'kind:pulls' })
      ] }), node('column', { id: 'github-feed-controls', appearance: 'plain' }, [node('textField', { id: 'query', action: 'query',
        placeholder: t('Search loaded items', '搜索已加载条目'), value: state.query, symbol: 'magnifyingglass' }),
        row([repositoryPicker(), filterMenu()])])];
    const reachedLimit = totalItems >= maximumSidebarItems || totalItems > visibleItems.length;
    const hasLocalFilters = !!(state.query.trim() || state.author || state.label);
    if (reachedLimit) children.push(styledText(t(
      `Showing ${visibleItems.length} loaded matches. Narrow the repository or search to continue.`,
      `显示 ${visibleItems.length} 个已加载匹配；缩小仓库范围或搜索后可继续。`)));
    if (state.moreItems && hasLocalFilters) children.push(styledText(t(
      'Clear search or filters to continue loading by scrolling.', '清除搜索或筛选后可继续下拉加载。')));
    if (state.itemsLoading) children.push(node('progress', { text: t('Loading items…', '正在加载条目…') }));
    const error = state.error || state.itemLoadError;
    if (error) children.push(node('badge', { text: short(error, 512), tone: 'danger' }),
      button(t('Try again', '重试'), 'retry-load', state.itemsLoading, { symbol: 'arrow.clockwise' }));
    if (!visibleItems.length && !state.itemsLoading) children.push(styledText(
      state.moreItems ? t('No matching items on the loaded pages. Scroll down to continue.', '已加载页面暂无匹配条目，下拉可继续加载。')
        : state.query || state.author || state.label ? t('No matching loaded items.', '已加载条目中没有匹配结果。')
          : state.kind === 'pulls' ? t('No pull requests in this view.', '当前范围暂无 PR。') : t('No Issues in this view.', '当前范围暂无 Issues。')));
    return node('sidebar', { id: 'item-navigation', value: state.selected && state.detailsVisible ? itemKey(state.selected) : '',
      ...(state.moreItems && !state.itemsLoading && !state.itemLoadError && !reachedLimit && !hasLocalFilters
        ? { loadMoreAction: 'more-items', loadMoreToken: feedToken() } : {}),
      items: visibleItems.map((item, index) => {
        const itemState = itemStatus(item), key = itemKey(item);
        const avatar = index < avatarCount ? cachedAvatar(ownerAvatarSource(item))?.base64 : null;
        return node('navigationItem', { id: key, text: boundedText(String(item.title || ''), 512, '…'),
          subtitle: `#${item.number} · ${itemRepository(item)}`, symbol: 'person.crop.circle', tone: 'neutral', action: `item:${key}`,
          ...(avatar ? { avatarBase64: avatar } : {}) }, [node('badge', itemState)]);
      }) }, children);
  }
  function filterMenu() {
    const choices = (selected, values) => [...new Set([selected, ...values.filter(value => typeof value === 'string' && value).sort()]
      .filter(Boolean))].slice(0, 32);
    const authors = choices(state.author, state.items.map(item => item.user?.login).map(value => short(value, 64)));
    const labels = choices(state.label, state.items.flatMap(itemLabels));
    const filterCount = Number(!!state.author) + Number(!!state.label);
    const stateLabel = state.status === 'all' ? t('All states', '全部状态') : state.status === 'closed' ? t('Closed', '已关闭') : t('Open', '未关闭');
    const label = filterCount ? t(`${stateLabel} · ${filterCount} ${filterCount === 1 ? 'filter' : 'filters'}`, `${stateLabel} · ${filterCount} 项筛选`) : stateLabel;
    return menu(label, [
      node('picker', { id: 'status', text: t('State on GitHub', 'GitHub 状态'), action: 'status', value: state.status,
        options: [{ value: 'open', text: t('Open', '未关闭') }, { value: 'closed', text: t('Closed', '已关闭') }, { value: 'all', text: t('All', '全部') }] }),
      node('divider'),
      node('picker', { id: 'author', text: t('Author in loaded items', '已加载条目的作者'), action: 'author', value: state.author,
        options: [{ value: '', text: t('All authors', '全部作者') }, ...authors.map(value => ({ value, text: value }))] }),
      node('picker', { id: 'label', text: t('Label in loaded items', '已加载条目的标签'), action: 'label', value: state.label,
        options: [{ value: '', text: t('All labels', '全部标签') }, ...labels.map(value => ({ value, text: value }))] }),
      node('divider'), button(t('Clear filters', '清除筛选'), 'clear-filters')
    ], 'line.3.horizontal.decrease');
  }
  function detailView() {
    const item = state.selected, status = itemStatus(item), date = itemDate(item);
    if (pullView.supportsNativeLayout && (state.kind === 'issues' || pullDetails.current)) {
      const isPR = state.kind === 'pulls', model = isPR ? pullDetails.current : { item, repo: itemRepository(item), number: item.number };
      const toolbar = node('toolbar', {}, [node('spacer'),
        button(t('Hand to Nora', '交给 Nora'), 'handoff-item', state.detailLoading || !!state.detailError, { appearance: 'primary', symbol: 'sparkles' }),
        button(message.refresh, 'refresh-detail', state.detailLoading, { appearance: 'icon', symbol: 'arrow.clockwise' }),
        button(t('View on GitHub', '在 GitHub 查看'), 'open-item', false, { appearance: 'icon', symbol: 'arrow.up.forward.square' })]);
      const summary = column([row([node('badge', status),
        styledText(boundedText(String(item.title || ''), 8192, '…'), 'title', 'neutral'),
        styledText(`#${item.number}`, 'caption')])]);
      const body = state.detailLoading ? [node('progress', { text: t('Loading details…', '正在加载详情…') })]
        : state.detailError ? [node('badge', { text: short(state.detailError, 512), tone: 'danger' }), button(t('Retry details', '重试详情'), 'retry-detail')]
          : isPR ? pullView.nativeContent(model) : [pullView.nativeDescription(model, item.html_url, 'issue-description'),
            button(t('View discussion on GitHub', '在 GitHub 查看讨论'), 'open-item', false, { appearance: 'plain', symbol: 'text.bubble' })];
      const tabs = isPR ? pullView.tabs(model) : node('tabBar', { id: 'issue-tabs' }, [node('button', { id: 'issue-tab-description', text: t('Overview', '概览'), value: 'selected' })]);
      const aside = isPR && !state.detailLoading && !state.detailError ? pullView.nativeAside(model) : [];
      return node('detail', { id: 'item-details', ...(aside.length ? { items: aside } : {}) }, [toolbar, summary, tabs, ...body]);
    }
    const children = [
      node('toolbar', {}, [styledText(`${itemRepository(item)} · ${state.kind === 'pulls' ? 'PR' : 'Issue'} #${item.number}`, 'monospaced'),
        node('badge', status), node('spacer'),
        button(message.refresh, 'refresh-detail', state.detailLoading, { appearance: 'icon', symbol: 'arrow.clockwise' }),
        button(t('View on GitHub', '在 GitHub 查看'), 'open-item', false, { appearance: 'icon', symbol: 'arrow.up.forward.square' }),
        button(t('Close details', '关闭详情'), 'close-detail', false, { appearance: 'icon', symbol: 'xmark' })]),
      column([
        styledText(boundedText(String(item.title || ''), 8192, '…'), 'title', 'neutral'),
        styledText([short(item.user?.login || t('Unknown author', '未知作者'), 64), date].filter(Boolean).join(' · ')),
        ...(itemLabels(item).length ? [styledText(boundedText(itemLabels(item).join(' · '), 4096,
          ' · ' + t('More labels are available on GitHub.', '更多标签可在 GitHub 查看。')))] : []),
        row([button(t('Hand to Nora', '交给 Nora'), 'handoff-item', state.detailLoading || !!state.detailError, { appearance: 'primary', symbol: 'sparkles' })])
      ])];
    if (state.detailLoading) children.push(node('progress', { text: t('Loading details…', '正在加载详情…') }));
    else if (state.detailError) children.push(node('badge', { text: short(state.detailError, 512), tone: 'danger' }),
      button(t('Retry details', '重试详情'), 'retry-detail', false, { symbol: 'arrow.clockwise' }));
    else if (state.kind === 'pulls' && pullDetails.current) children.push(
      ...pullView.summary(pullDetails.current), ...pullView.content(pullDetails.current), ...pullView.actions(pullDetails.current));
    else children.push(node('markdown', { text: displayedBody(item.body) }));
    return node('column', { id: 'item-details' }, children);
  }
  function emptyListView() {
    if (state.itemsLoading) return node('emptyState', { text: t('Loading from GitHub…', '正在从 GitHub 加载…'),
      subtitle: t('Fetching items from your accessible repositories.', '正在获取你可访问仓库中的条目。'), symbol: 'arrow.clockwise' }, [node('progress')]);
    if (state.error || state.itemLoadError) return node('emptyState', { text: t('Couldn’t load this view', '暂时无法加载'), subtitle: state.error || state.itemLoadError, symbol: 'exclamationmark.circle' },
      [button(state.error === message.expired ? t('Reconnect GitHub', '重新连接 GitHub') : t('Try again', '重试'),
        state.error === message.expired ? 'begin-login' : 'retry-load', false, { appearance: 'primary' }), button(message.manage, 'manage')]);
    if (filteredItems().length) return node('emptyState', { text: state.kind === 'pulls' ? t('Select a pull request', '选择一条 PR') : t('Select an Issue', '选择一条 Issue'),
      subtitle: state.kind === 'pulls' ? t('Read the conversation, review changes, and hand the work to Nora.', '查看讨论与变更，把需要处理的工作交给 Nora。')
        : t('Read the description and hand the work to Nora.', '查看问题描述，把需要处理的工作交给 Nora。'), symbol: state.kind === 'pulls' ? 'arrow.triangle.pull' : 'circle.circle' });
    if (state.moreItems && !(state.query.trim() || state.author || state.label)) return node('emptyState', { text: t('No matching items on the loaded pages', '已加载页面暂无匹配条目'),
      subtitle: t('Scroll down in the sidebar to load more items.', '在侧边栏下拉可继续加载条目。'), symbol: 'tray' });
    const filtered = state.query || state.author || state.label;
    return node('emptyState', { text: filtered ? t('No matching loaded items', '已加载条目中没有匹配结果')
      : state.kind === 'pulls' ? t('No pull requests in this view', '此视图暂无 PR') : t('No Issues in this view', '此视图暂无 Issues'),
      subtitle: filtered ? t('Adjust your filters or search. Search only covers items already loaded.', '调整筛选或搜索条件；搜索仅覆盖已经加载的条目。')
        : t('Try another state or switch between Issues and pull requests.', '尝试其他状态，或切换 Issues 与 PR。'), symbol: state.kind === 'pulls' ? 'arrow.triangle.pull' : 'tray' },
      [button(filtered ? t('Clear filters', '清除筛选') : t('Show all states', '查看全部状态'), filtered ? 'clear-filters' : 'all-states', false, { appearance: 'secondary' })]);
  }
  function collectParticipants(main) {
    const images = [];
    let unlinkedCommit = false;
    const visit = entry => {
      const participant = participantButtons.get(entry);
      if (participant?.source) visibleParticipants.set(avatarKey(participant.source), participant.source);
      if (participant?.unlinkedCommit) unlinkedCommit = true;
      if (participant && entry.avatarBase64) images.push(entry);
      for (const child of [...(entry.children || []), ...(entry.items || [])]) visit(child);
    };
    visit(main);
    return { images, unlinkedCommit };
  }
  async function loadParticipantCommits() {
    const model = pullDetails.current, current = generation, user = state.user;
    if (!model || participantCommitsOperation === model || model.sections.commits.loaded && !model.sections.commits.nextPage || model.sections.commits.loading || model.sections.commits.error) return;
    participantCommitsOperation = model;
    try {
      await pullDetails.more('commits');
      if (current === generation && state.user === user && pullDetails.current === model && state.detailsVisible) invalidatePanel(current, user);
    } finally { if (participantCommitsOperation === model) participantCommitsOperation = null; }
  }
  function view() {
    participantButtons = new WeakMap(); visibleParticipants = new Map(); visibleParticipantPage = participantPage();
    if (restoreOperation?.generation === generation) return node('emptyState', { id: 'github-restoring', text: t('Connecting to GitHub…', '正在连接 GitHub…'),
      subtitle: t('Restoring your account and loading your work.', '正在恢复账号并加载工作条目。') }, [node('progress')]);
    if (!state.user) return connectionView();
    const items = filteredItems();
    let visibleItems = items.slice(0, maximumSidebarItems);
    const header = node('toolbar', {}, [styledText(`${state.repo || t('All repositories', '所有仓库')} / ${state.kind === 'pulls' ? t('Pull requests', 'PR') : 'Issues'}`, 'caption', 'neutral'), node('spacer'),
      button(message.refresh, 'refresh', state.itemsLoading || state.reposLoading, { appearance: 'icon', symbol: 'arrow.clockwise' })]);
    let main;
    if (state.showOtherRepository) {
      main = column([header, node('emptyState', { id: 'other-repository', text: t('Open another repository', '打开其他仓库'),
        subtitle: t('Enter owner/name. Your connected account must have access.', '输入 owner/name；已连接的账号需要拥有访问权限。'), symbol: 'folder.badge.plus' }, [
        ...(state.error ? [node('badge', { text: state.error, tone: 'danger' })] : []),
        node('column', { id: 'github-repository-form', appearance: 'secondary' }, [
          node('textField', { id: 'manual-repo', placeholder: 'owner/name', value: state.manualRepository }),
          row([button(t('Cancel', '取消'), 'cancel-other-repo', false, { appearance: 'plain' }), node('spacer'),
            button(t('Open repository', '打开仓库'), 'open-repo', false, { appearance: 'primary' })]),
        ]),
      ])]);
    } else {
      main = state.selected && state.detailsVisible ? detailView() : column([header, emptyListView()]);
    }
    const participants = collectParticipants(main);
    if (participants.unlinkedCommit && visibleParticipantPage && state.kind === 'pulls') void loadParticipantCommits().catch(() => {});
    const properties = { id: 'github-workspace', action: 'close-detail', value: state.selected && state.detailsVisible ? itemKey(state.selected) : '' };
    let avatarCount = visibleItems.length;
    let sidebar = itemSidebar(visibleItems, items.length, avatarCount);
    for (const image of participants.images.slice().reverse()) {
      if (encodedViewSize({ type: 'workspace', ...properties, children: [sidebar, main] }) <= 400 * 1024) break;
      delete image.avatarBase64;
      image.symbol = 'person.crop.circle';
    }
    if (avatarCount > 0 && encodedViewSize({ type: 'workspace', ...properties, children: [sidebar, main] }) > 400 * 1024) {
      let minimum = 0, maximum = avatarCount;
      while (minimum < maximum) {
        const candidate = Math.ceil((minimum + maximum) / 2);
        const candidateSidebar = itemSidebar(visibleItems, items.length, candidate);
        if (encodedViewSize({ type: 'workspace', ...properties, children: [candidateSidebar, main] }) <= 400 * 1024) minimum = candidate;
        else maximum = candidate - 1;
      }
      avatarCount = minimum;
      sidebar = itemSidebar(visibleItems, items.length, avatarCount);
    }
    while (visibleItems.length > 1 && (encodedViewSize({ type: 'workspace', ...properties, children: [sidebar, main] }) > 400 * 1024
      || viewNodeCount({ children: [sidebar, main] }) > 950)) {
      visibleItems = visibleItems.slice(0, Math.max(1, visibleItems.length - 20));
      if (state.selected && state.detailsVisible && !visibleItems.some(item => itemKey(item) === itemKey(state.selected))) {
        visibleItems = [...visibleItems.slice(0, -1), state.selected];
      }
      sidebar = itemSidebar(visibleItems, items.length, 0);
    }
    return node('workspace', properties, [sidebar, main]);
  }
  function githubURL(url) {
    if (typeof url !== 'string' || !/^https:\/\/github\.com\/(?!\/)/.test(url) || /[\s\\]/.test(url)) throw new Error(message.invalid);
    return url;
  }
  const web = async url => nora.request('browser.open', { url: githubURL(url) });
  const pullDetails = createPullRequestDetails({ api, write: writeAPI, t, boundedText, githubURL,
    isCurrent: item => state.kind === 'pulls' && state.detailsVisible && state.selected && itemKey(state.selected) === itemKey(item),
    onUpdated: item => {
      if (state.kind !== 'pulls' || !state.detailsVisible || !state.selected || itemKey(state.selected) !== itemKey(item)) return;
      state.selected = item;
      state.items = state.items.map(loaded => itemKey(loaded) === itemKey(item) ? item : loaded);
    }
  });
  const pullView = createPullRequestView({ node, t, boundedText, displayedBody, short, itemStatus, itemDate,
    avatarFor: account => {
      const source = participantSource(account);
      if (!source) return null;
      return source.accountAvatar ? state.avatarBase64 : cachedAvatar(source)?.base64;
    },
    onAuthorButton: (button, account, entry) => participantButtons.set(button, {
      source: participantSource(account), unlinkedCommit: !account.login && entry.event === 'committed' && /^[a-f\d]{40}$/i.test(entry.sha || '') &&
        !pullDetails.current?.sections.commits.items.some(commit => commit.sha?.toLowerCase() === entry.sha.toLowerCase()),
    }),
    currentUser: () => state.user,
    supportsDetailAside: nora.features?.detailAside === true,
    supportsItemRowIcon: nora.features?.itemRowIcon === true,
    supportsNativeTimeline: typeof nora.ui.timelineItem === 'function',
    supportsTextEditor: typeof nora.ui.textEditor === 'function', supportsNativeDiff: typeof nora.ui.diff === 'function',
    supportsNativeLayout: ['detail', 'tabBar', 'splitView', 'itemRow'].every(kind => typeof nora.ui[kind] === 'function') });
  nora.registerPanel(panelID, async (event = {}) => {
    const revision = ++renderRevision;
    if (event.action) state.error = '';
    const values = event.values || {};
    const commentField = pullDetails.current?.comment.fieldID;
    if (commentField && typeof values[commentField] === 'string') pullDetails.setCommentDraft(values[commentField]);
    try {
      const action = event.action;
      if (['refresh', 'refresh-detail', 'pr-refresh'].includes(action)) retryFailedAvatars();
      if (!action && !state.restored && supportsPanelInvalidation) {
        startRestore();
        return view();
      }
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
        await Promise.all([loadRepositories(), loadItems()]);
      }
      else if (action === 'refresh-repos') await loadRepositories();
      else if (action === 'retry-load') {
        if (!state.user) {
          if (restoreOperation?.generation !== generation) state.restored = false;
          if (supportsPanelInvalidation) startRestore();
          else await restore();
        }
        else await loadItems(state.itemRetryAppend, true);
      }
      else if (action === 'more-repos') await loadRepositories(true);
      else if (action === 'more-items') await loadItems(true);
      else if (action === 'show-other-repo') { state.showOtherRepository = true; state.manualRepository = ''; }
      else if (action === 'cancel-other-repo') { state.showOtherRepository = false; state.manualRepository = ''; }
      else if (action === 'repo-query') state.repoQuery = short(event.value ?? values['repo-query'] ?? '', 1024);
      else if (action === 'open-repo' || action === 'repository' || action?.startsWith('repo:')) {
        if (action === 'open-repo') state.manualRepository = short(values['manual-repo'], 4096);
        const selectedRepository = action === 'open-repo' ? state.manualRepository : action.startsWith('repo:') ? action.slice(5) : (event.value ?? values.repository);
        state.repo = action !== 'open-repo' && selectedRepository === '' ? '' : repository(selectedRepository);
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
        const item = findSelectedItem(action.slice(5));
        if (item) await loadDetail(item);
        else clearDetails();
      }
      else if (action === 'peek-item') {
        const selectedID = event.value ?? values['item-navigation'] ?? values.items ?? (state.selected ? itemKey(state.selected) : '');
        const selected = findSelectedItem(selectedID);
        if (!selected) clearDetails();
        else if (state.selected && itemKey(state.selected) === itemKey(selected) && state.detailsVisible) {
          ++detailRevision; state.detailsVisible = false; state.detailLoading = false; state.detailError = '';
        } else await loadDetail(selected);
      }
      else if (action === 'close-detail') clearDetails();
      else if (action === 'retry-detail' && state.selected && state.detailsVisible) await loadDetail(state.selected, { preserveTab: true });
      else if ((action === 'refresh-detail' || action === 'pr-refresh') && state.selected && state.detailsVisible) {
        if (state.kind === 'pulls' && pullDetails.current) await pullDetails.refresh();
        else await loadDetail(state.selected, { preserveTab: true });
      }
      else if (action?.startsWith('pr-tab:')) {
        const record = pullDetails.current, tab = action.slice(7);
        await pullDetails.selectTab(tab);
        if (tab === 'checks' && pullView.supportsNativeLayout && record && pullDetails.current === record) {
          const run = pullView.workflow(record);
          if (run) {
            record.selectedRunID = run.id;
            record.checksDetailVisible = false;
            if (!record.jobsByRun[run.id]) await pullDetails.jobs(run.id);
          }
        }
      }
      else if (action?.startsWith('pr-more:')) await pullDetails.more(action.slice(8));
      else if (action?.startsWith('pr-file:') && pullDetails.current) {
        const index = Number(action.slice(8)), model = pullDetails.current;
        if (/^\d+$/.test(action.slice(8)) && Number.isSafeInteger(index) && index >= 0 && index < model.sections.files.items.length) {
          model.selectedFileID = model.sections.files.items[index].filename;
          model.filesDetailVisible = true;
        }
      }
      else if (action === 'pr-files-back' && pullDetails.current) pullDetails.current.filesDetailVisible = false;
      else if (action?.startsWith('pr-ci:') && pullDetails.current && ['actions', 'checks', 'statuses'].includes(action.slice(6))) {
        pullDetails.current.checksSource = action.slice(6);
        pullDetails.current.checksDetailVisible = false;
      }
      else if (action?.startsWith('pr-jobs:')) {
        const record = pullDetails.current, runID = Number(action.slice(8));
        if (record && record.sections.workflows.items.some(run => run.id === runID && typeof run.head_sha === 'string' && run.head_sha.toLowerCase() === record.headSHA)) {
          record.selectedRunID = runID;
          record.selectedJobID = null;
          record.checksSource = 'actions';
          record.checksDetailVisible = false;
          await pullDetails.jobs(runID);
        }
      }
      else if (action?.startsWith('pr-job:') && pullDetails.current) {
        const jobID = Number(action.slice(7)), model = pullDetails.current;
        if (model.jobsByRun[model.selectedRunID]?.items.some(job => job.id === jobID)) {
          model.selectedJobID = jobID;
          model.checksDetailVisible = true;
        }
      }
      else if (action === 'pr-ci-back' && pullDetails.current) pullDetails.current.checksDetailVisible = false;
      else if ((action?.startsWith('pr-check:') || action?.startsWith('pr-status:')) && pullDetails.current) {
        const model = pullDetails.current, isCheck = action.startsWith('pr-check:'), id = Number(action.slice(isCheck ? 9 : 10));
        if (model.sections[isCheck ? 'checks' : 'statuses'].items.some(entry => entry.id === id)) {
          model[isCheck ? 'selectedCheckID' : 'selectedStatusID'] = id;
          model.checksDetailVisible = true;
        }
      }
      else if (action?.startsWith('pr-commits:') && pullDetails.current) pullView.toggleCommitGroup(pullDetails.current, action.slice(11));
      else if (action === 'pr-toggle-merge' && pullDetails.current) pullDetails.current.mergeExpanded = !pullDetails.current.mergeExpanded;
      else if (action === 'pr-comment') await pullDetails.postComment({ authorized: typeof event.actionCapability === 'string' && !!event.actionCapability.trim() });
      else if (action?.startsWith('pr-merge:')) {
        if (pullDetails.current) pullDetails.current.mergeExpanded = true;
        pullDetails.prepareMerge(action.slice(9));
      }
      else if (action === 'pr-confirm-merge') {
        if (pullDetails.current) pullDetails.current.mergeExpanded = true;
        await pullDetails.confirmMerge({ authorized: typeof event.actionCapability === 'string' && !!event.actionCapability.trim() });
      }
      else if (action === 'pr-cancel-merge') pullDetails.cancelMerge();
      else if (action?.startsWith('pr-open:')) await web(decodeURIComponent(action.slice(8)));
      else if (action === 'handoff-item') {
        if (!await nora.chat.openDraft(draftForSelectedItem(), event)) throw new Error(t('Nora could not open this draft. Try again.', 'Nora 暂时无法打开草稿，请重试。'));
      }
      else if (action === 'open-item' && state.selected) await web(state.selected.html_url);
    } catch (error) { if (revision === renderRevision) state.error = error?.message || message.network; }
    const result = view();
    void loadOwnerAvatars().catch(() => {});
    void loadParticipantAvatars().catch(() => {});
    return result;
  });
  nora.registerCommand('com.nora.github.listRepositories', listRepositories);
  nora.registerCommand('com.nora.github.listIssues', args => listItems(args, 'issues'));
  nora.registerCommand('com.nora.github.listPullRequests', args => listItems(args, 'pulls'));
})();
