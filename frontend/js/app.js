/* ============================================================
   TempMail SPA — 主应用逻辑
   ============================================================ */

'use strict';

// ─── 配置 ───────────────────────────────────────────────────
const API_BASE = '/api';
const PUBLIC_BASE = '/public';
const DEFAULT_SITE_TITLE = 'TempMail';
const SITE_TITLE_SUFFIX = '临时邮箱平台';
const DEFAULT_SITE_LOGO = '✉';
const DEFAULT_SITE_SUBTITLE = '临时邮箱服务 · 安全隔离 · 按需分配';
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_PAGE_SIZE_OPTIONS = [20, 50, 100];
const DASHBOARD_MAILBOX_PAGE_SIZE = 20;
const DASHBOARD_MAILBOX_PAGE_SIZE_OPTIONS = [20, 50, 100];
const INBOX_EMAIL_PAGE_SIZE = 20;
const INBOX_EMAIL_PAGE_SIZE_OPTIONS = [20, 50, 100];
const ADMIN_ACCOUNT_PAGE_SIZE = 50;
const ADMIN_ACCOUNT_PAGE_SIZE_OPTIONS = [20, 50, 100];
const CATCHALL_MAILBOX_PAGE_SIZE = 50;
const CATCHALL_MAILBOX_PAGE_SIZE_OPTIONS = [20, 50, 100, 200];
const DOMAIN_PAGE_SIZE = 20;
const DOMAIN_PAGE_SIZE_OPTIONS = [20, 50, 100];
const DEFAULT_RESERVED_MAILBOX_ADDRESSES = `admin
administrator
root
system
support
noreply
no-reply
no_reply
notification
notifications
notify
alerts
mailer-daemon
postmaster
hostmaster
webmaster
security
abuse
daemon`;

// ─── 状态 ───────────────────────────────────────────────────
const state = {
  apiKey:    localStorage.getItem('tm_apikey') || '',
  account:   JSON.parse(localStorage.getItem('tm_account') || 'null'),
  theme:     localStorage.getItem('tm_theme') || 'system',
  siteTitle: localStorage.getItem('tm_site_title') || DEFAULT_SITE_TITLE,
  siteLogo: localStorage.getItem('tm_site_logo') || DEFAULT_SITE_LOGO,
  siteSubtitle: localStorage.getItem('tm_site_subtitle') || DEFAULT_SITE_SUBTITLE,
  publicSettings: null,
  page:      'dashboard',
  dashboardMailboxPage: 1,
  dashboardMailboxPageSize: DASHBOARD_MAILBOX_PAGE_SIZE,
  // 当前邮箱
  currentMailbox: null,
  currentEmail:   null,
  // 缓存
  mailboxes: [],
  emails:    [],
  adminDomains: [],
  listViews: {},
  bulkSelections: {},
  bulkVisibleIds: {},
  bulkActionConfigs: {},
};

// ─── 工具函数 ───────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

function toast(msg, type = 'info') {
  const icons = { success: '✓', error: '✗', warn: '⚠', info: 'ℹ' };
  const t = el('div', `toast ${type}`, `<span>${icons[type]||'ℹ'}</span><span>${escHtml(msg)}</span>`);
  const c = $('toast-container');
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 3500);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function normalizeDomainInput(domain) {
  return String(domain || '').trim().toLowerCase().replace(/\.$/, '');
}

function isWildcardDomainPattern(domain) {
  return normalizeDomainInput(domain).startsWith('*.');
}

function getWildcardBaseDomain(domain) {
  return normalizeDomainInput(domain).replace(/^\*\./, '');
}

function getWildcardDomainExample(domain) {
  const base = getWildcardBaseDomain(domain);
  return base ? `inbox.${base}` : 'inbox.example.com';
}

function getWildcardDeepExample(domain) {
  const base = getWildcardBaseDomain(domain);
  return base ? `team.mail.${base}` : 'team.mail.example.com';
}

function buildWildcardCustomDomain(rule, rawInput) {
  const base = getWildcardBaseDomain(rule);
  const normalized = normalizeDomainInput(rawInput);
  if (!base || !normalized) return '';
  if (normalized === base || normalized.endsWith(`.${base}`)) return normalized;
  return `${normalized}.${base}`;
}

function splitManagedDomains(domains) {
  const grouped = { exact: [], wildcard: [] };
  for (const domain of (domains || [])) {
    if (isWildcardDomainPattern(domain?.domain || domain)) grouped.wildcard.push(domain);
    else grouped.exact.push(domain);
  }
  return grouped;
}

function renderWildcardExamplesHtml(domain) {
  const primary = getWildcardDomainExample(domain);
  const secondary = `也支持 ${getWildcardDeepExample(domain)}`;
  return `
    <div class="domain-example-stack domain-example-nowrap">
      <code title="${escHtml(primary)}">${escHtml(primary)}</code>
      <div class="domain-example-note" title="${escHtml(secondary)}">${escHtml(secondary)}</div>
    </div>
  `;
}

function renderDomainTypeHtml(domain) {
  if (isWildcardDomainPattern(domain)) {
    const base = getWildcardBaseDomain(domain);
    return `<span class="badge badge-gold">通配子域</span><span class="domain-type-detail" title="匹配任意 *.${escHtml(base)}，不含根域">匹配任意 *.${escHtml(base)}，不含根域</span>`;
  }
  return `<span class="badge badge-gray">精确域名</span>`;
}

function formatDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
}

function timeAgo(s) {
  if (!s) return '—';
  const diff = Date.now() - new Date(s).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}小时前`;
  return `${Math.floor(hrs/24)}天前`;
}

function getListViewState(key, defaults = {}) {
  const fallbackPage = Number(defaults.page) > 0 ? Number(defaults.page) : 1;
  const fallbackSize = Number(defaults.size) > 0 ? Number(defaults.size) : DEFAULT_PAGE_SIZE;
  const normalizedDefaults = {
    ...defaults,
    page: fallbackPage,
    size: fallbackSize,
  };
  if (!state.listViews[key]) {
    state.listViews[key] = { ...normalizedDefaults };
  } else {
    state.listViews[key] = { ...normalizedDefaults, ...state.listViews[key] };
  }
  const current = state.listViews[key];
  const page = Number(current.page);
  const size = Number(current.size);
  current.page = Number.isFinite(page) && page > 0 ? page : fallbackPage;
  current.size = Number.isFinite(size) && size > 0 ? size : fallbackSize;
  current.__defaults = normalizedDefaults;
  return current;
}

function updateListViewState(key, patch = {}, defaults = {}) {
  const current = getListViewState(key, defaults);
  state.listViews[key] = { ...current, ...patch };
  return getListViewState(key, defaults);
}

function normalizePaginatedResponse(response, fallbackPage = 1, fallbackSize = 20) {
  const data = Array.isArray(response) ? response : (response?.data || []);
  const parsedPage = Number(Array.isArray(response) ? fallbackPage : response?.page);
  const parsedSize = Number(Array.isArray(response) ? fallbackSize : response?.size);
  const parsedTotal = Number(Array.isArray(response) ? data.length : response?.total);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : fallbackPage;
  const size = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : fallbackSize;
  const total = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : data.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  return { data, total, page, size, totalPages };
}

function paginateLocalItems(items = [], page = 1, size = DEFAULT_PAGE_SIZE) {
  const data = Array.isArray(items) ? items : [];
  const safeSize = Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : DEFAULT_PAGE_SIZE;
  const total = data.length;
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * safeSize;
  return {
    data: data.slice(start, start + safeSize),
    total,
    page: safePage,
    size: safeSize,
    totalPages,
  };
}

function getLocalPageData(key, items = [], defaultSize = DEFAULT_PAGE_SIZE) {
  const pagerState = getListViewState(key, { page: 1, size: defaultSize });
  const pageData = paginateLocalItems(items, pagerState.page, pagerState.size);
  updateListViewState(key, { page: pageData.page, size: pageData.size }, { page: 1, size: defaultSize });
  return pageData;
}

function getPaginationPages(page, totalPages, windowSize = 5) {
  if (totalPages <= 0) return [];
  const pages = new Set([1, totalPages, page]);
  const half = Math.floor(windowSize / 2);
  const start = Math.max(1, page - half);
  const end = Math.min(totalPages, page + half);
  for (let current = start; current <= end; current += 1) {
    pages.add(current);
  }
  const ordered = [...pages].sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const current = ordered[i];
    const prev = ordered[i - 1];
    if (i > 0 && current - prev > 1) {
      result.push('ellipsis');
    }
    result.push(current);
  }
  return result;
}

function getListSearchInputId(key, field = 'q') {
  return `list-search-${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}-${String(field).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function buildPaginationBar({
  page,
  size,
  total,
  totalPages,
  itemLabel = '条',
  pageSizeOptions = [],
  onPageChange,
  onPageSizeChange,
  pagerKey = '',
  compact = false,
  hideIfSinglePage = false,
}) {
  if (total <= 0 || (hideIfSinglePage && totalPages <= 1)) return '';

  const start = (page - 1) * size + 1;
  const end = Math.min(total, page * size);
  const pages = getPaginationPages(page, totalPages);
  const keyArg = pagerKey ? `${JSON.stringify(String(pagerKey))}, ` : '';
  const paginationButtons = totalPages > 1
    ? `
      <button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} onclick='${onPageChange}(${keyArg}${page - 1})'>上一页</button>
      ${pages.map(item => item === 'ellipsis'
        ? `<span style="padding:0 0.2rem;color:var(--text-muted)">…</span>`
        : `<button class="btn ${item === page ? 'btn-primary' : 'btn-ghost'} btn-sm" style="min-width:2.4rem" onclick='${onPageChange}(${keyArg}${item})'>${item}</button>`).join('')}
      <button class="btn btn-ghost btn-sm" ${page >= totalPages ? 'disabled' : ''} onclick='${onPageChange}(${keyArg}${page + 1})'>下一页</button>
    `
    : '';
  const pageSizeSelect = pageSizeOptions.length > 0
    ? `
      <label style="display:flex;align-items:center;gap:0.45rem;font-size:0.8rem;color:var(--text-secondary)">
        <span>每页</span>
        <select class="form-input" style="width:auto;min-width:84px" onchange='${onPageSizeChange}(${keyArg}this.value)'>
          ${pageSizeOptions.map(option => `
            <option value="${option}" ${Number(option) === Number(size) ? 'selected' : ''}>${option}</option>
          `).join('')}
        </select>
      </label>
    `
    : '';
  const wrapperStyle = compact
    ? 'padding:0.8rem 1rem;border-top:1px solid var(--border)'
    : 'margin-top:0.8rem;padding:0.8rem 1rem';
  const wrapperClass = compact ? '' : ' class="card"';

  return `
    <div${wrapperClass} style="${wrapperStyle}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:0.8rem;flex-wrap:wrap">
        <div style="font-size:0.82rem;color:var(--text-secondary)">
          当前显示 <strong>${start}</strong> - <strong>${end}</strong> / 共 <strong>${total}</strong> 个${escHtml(itemLabel)}
        </div>
        <div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap">
          ${pageSizeSelect}
          ${paginationButtons}
        </div>
      </div>
    </div>
  `;
}

function buildListFilterBar({
  key,
  searchField = 'q',
  searchValue = '',
  searchPlaceholder = '搜索…',
  searchButtonLabel = '搜索',
  filters = [],
  hint = '',
  resetLabel = '清空筛选',
}) {
  const searchInputId = getListSearchInputId(key, searchField);
  return `
    <div class="card" style="margin-bottom:0.8rem;padding:0.85rem 1rem">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:0.8rem;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;flex:1 1 420px">
          <input
            class="form-input"
            id="${searchInputId}"
            value="${escHtml(searchValue || '')}"
            placeholder="${escHtml(searchPlaceholder)}"
            style="min-width:220px;flex:1 1 260px"
            onkeydown='handleListSearchKeydown(event, ${JSON.stringify(String(key))}, ${JSON.stringify(String(searchField))})'
          />
          <button class="btn btn-primary btn-sm" onclick='applyListSearch(${JSON.stringify(String(key))}, ${JSON.stringify(String(searchField))})'>${escHtml(searchButtonLabel)}</button>
          ${filters.map(filter => `
            <label style="display:flex;align-items:center;gap:0.45rem;font-size:0.8rem;color:var(--text-secondary)">
              <span>${escHtml(filter.label || '筛选')}</span>
              <select class="form-input" style="width:auto;min-width:110px" onchange='setListViewField(${JSON.stringify(String(key))}, ${JSON.stringify(String(filter.field || 'type'))}, this.value)'>
                ${(filter.options || []).map(option => `
                  <option value="${escHtml(option.value)}" ${String(option.value) === String(filter.value) ? 'selected' : ''}>${escHtml(option.label)}</option>
                `).join('')}
              </select>
            </label>
          `).join('')}
        </div>
        <div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick='resetListViewFilters(${JSON.stringify(String(key))})'>${escHtml(resetLabel)}</button>
        </div>
      </div>
      ${hint ? `<div class="form-hint" style="margin-top:0.55rem">${escHtml(hint)}</div>` : ''}
    </div>
  `;
}

function buildQueryString(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    query.set(key, normalized);
  });
  const result = query.toString();
  return result ? `?${result}` : '';
}

function withQuery(base, params = {}) {
  return `${base}${buildQueryString(params)}`;
}

function resetRelatedListPages(key) {
  const mappings = {
    'domains-guide-controls': ['domains-guide-pending', 'domains-guide-exact', 'domains-guide-wildcard'],
    'admin-domains-controls': ['admin-domains-pending', 'admin-domains-exact', 'admin-domains-wildcard'],
  };
  for (const relatedKey of (mappings[key] || [])) {
    if (!state.listViews[relatedKey]) continue;
    state.listViews[relatedKey].page = 1;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'success');
  } catch {
    toast('复制失败，请手动选择', 'warn');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTemporaryRequestStatus(status) {
  return [429, 502, 503, 504].includes(Number(status));
}

function isTemporaryRequestError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.rawMessage || error?.message || '').toLowerCase();
  return isTemporaryRequestStatus(status)
    || message.includes('rate limit exceeded')
    || message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('service unavailable')
    || message.includes('gateway timeout')
    || message.includes('正在唤醒')
    || message.includes('请稍候刷新');
}

function getTemporaryRequestMessage(error) {
  if (!error) return '服务正在恢复中，请稍候再试。';
  if (Number(error.status) === 429 || String(error?.rawMessage || error?.message || '').toLowerCase().includes('rate limit exceeded')) {
    return '服务刚恢复或短时间请求过多，请稍候几秒再试。';
  }
  return '服务正在唤醒或临时不可用，请稍候几秒再试。';
}

function getDisplayErrorMessage(error) {
  if (!error) return '请求失败';
  if (isTemporaryRequestError(error)) {
    return getTemporaryRequestMessage(error);
  }
  return String(error.message || error.rawMessage || '请求失败');
}

function getSiteTitle() {
  const title = state.publicSettings?.site_title || state.siteTitle || DEFAULT_SITE_TITLE;
  return String(title).trim() || DEFAULT_SITE_TITLE;
}

function getSiteLogo() {
  const logo = state.publicSettings?.site_logo || state.siteLogo || DEFAULT_SITE_LOGO;
  return String(logo).trim() || DEFAULT_SITE_LOGO;
}

function getSiteSubtitle() {
  const subtitle = state.publicSettings?.site_subtitle || state.siteSubtitle || DEFAULT_SITE_SUBTITLE;
  return String(subtitle).trim() || DEFAULT_SITE_SUBTITLE;
}

function getBulkSelection(key) {
  if (!state.bulkSelections[key]) {
    state.bulkSelections[key] = new Set();
  }
  return state.bulkSelections[key];
}

function setBulkVisibleIds(key, ids) {
  const visible = (ids || []).map(id => String(id));
  state.bulkVisibleIds[key] = visible;
  const visibleSet = new Set(visible);
  const selection = getBulkSelection(key);
  for (const id of [...selection]) {
    if (!visibleSet.has(id)) selection.delete(id);
  }
}

function getBulkSelectedIds(key) {
  const selection = getBulkSelection(key);
  const visible = state.bulkVisibleIds[key] || [];
  return visible.filter(id => selection.has(id));
}

function isBulkSelected(key, id) {
  return getBulkSelection(key).has(String(id));
}

window.toggleBulkSelection = function(key, id, checked) {
  const selection = getBulkSelection(key);
  const normalizedId = String(id);
  if (checked) selection.add(normalizedId);
  else selection.delete(normalizedId);
  updateBulkUI(key);
};

window.toggleBulkSelectAll = function(key, checked) {
  const selection = getBulkSelection(key);
  selection.clear();
  if (checked) {
    for (const id of state.bulkVisibleIds[key] || []) {
      selection.add(String(id));
    }
  }
  updateBulkUI(key);
};

window.clearBulkSelection = function(key) {
  getBulkSelection(key).clear();
  updateBulkUI(key);
};

window.invertBulkSelection = function(key) {
  const visible = state.bulkVisibleIds[key] || [];
  const selection = getBulkSelection(key);
  const nextSelected = visible.filter(id => !selection.has(id));
  selection.clear();
  for (const id of nextSelected) {
    selection.add(String(id));
  }
  updateBulkUI(key);
};

function getBulkActionSelectId(key) {
  return `bulk-action-select-${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

window.runSelectedBulkAction = async function(key) {
  const selectEl = document.getElementById(getBulkActionSelectId(key));
  const actionValue = selectEl?.value || '';
  if (!actionValue) {
    toast('请先选择批量操作', 'warn');
    return;
  }
  const action = (state.bulkActionConfigs[key] || []).find(item => item.value === actionValue);
  if (!action) {
    toast('无效的批量操作', 'error');
    return;
  }
  await action.run();
  if (selectEl) selectEl.value = '';
};

function buildBulkToolbar({ key, itemLabel, actions = [], scopeHint = '当前仅对当前已加载列表生效，暂不支持跨页全选。' }) {
  state.bulkActionConfigs[key] = actions;
  const visibleIds = state.bulkVisibleIds[key] || [];
  const selectedIds = getBulkSelectedIds(key);
  const allSelected = visibleIds.length > 0 && selectedIds.length === visibleIds.length;
  const selectId = getBulkActionSelectId(key);
  return `
    <div class="card" data-bulk-toolbar="${key}" data-bulk-item-label="${escHtml(itemLabel)}" style="margin-bottom:0.8rem;padding:0.8rem 1rem">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:0.8rem;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:0.8rem;flex-wrap:wrap;font-size:0.82rem;color:var(--text-secondary)">
          <label style="display:flex;align-items:center;gap:0.45rem;cursor:pointer">
            <input type="checkbox" data-bulk-role="select-all" ${allSelected ? 'checked' : ''} onchange="toggleBulkSelectAll('${key}', this.checked)">
            <span>全选当前列表</span>
          </label>
          <button class="btn btn-ghost btn-sm" onclick="invertBulkSelection('${key}')">反选</button>
          <span data-bulk-role="summary">已选 <strong>${selectedIds.length}</strong> / ${visibleIds.length} 个${escHtml(itemLabel)}</span>
          <button class="btn btn-ghost btn-sm" data-bulk-role="clear" style="${selectedIds.length > 0 ? '' : 'display:none'}" onclick="clearBulkSelection('${key}')">清空选择</button>
        </div>
        <div style="display:flex;gap:0.45rem;flex-wrap:wrap">
          <select class="form-input" id="${selectId}" style="min-width:190px">
            <option value="">选择批量操作…</option>
            ${actions.map(action => `
              <option value="${escHtml(action.value)}">${escHtml(action.label)}</option>
            `).join('')}
          </select>
          <button class="btn btn-primary btn-sm" data-bulk-role="execute" ${selectedIds.length === 0 || actions.length === 0 ? 'disabled' : ''} onclick="runSelectedBulkAction('${key}')">执行</button>
        </div>
      </div>
      <div class="form-hint" style="margin-top:0.55rem">${escHtml(scopeHint)}</div>
    </div>
  `;
}

function updateBulkUI(key) {
  const visibleIds = state.bulkVisibleIds[key] || [];
  const selectedIds = getBulkSelectedIds(key);
  const selectedSet = new Set(selectedIds.map(String));
  const allSelected = visibleIds.length > 0 && selectedIds.length === visibleIds.length;

  document.querySelectorAll(`[data-bulk-key="${key}"][data-bulk-id]`).forEach(input => {
    const id = String(input.getAttribute('data-bulk-id') || '');
    input.checked = selectedSet.has(id);
  });

  document.querySelectorAll(`[data-bulk-toolbar="${key}"]`).forEach(toolbar => {
    const selectAll = toolbar.querySelector('[data-bulk-role="select-all"]');
    if (selectAll) selectAll.checked = allSelected;

    const summary = toolbar.querySelector('[data-bulk-role="summary"]');
    if (summary) {
      const itemLabel = toolbar.getAttribute('data-bulk-item-label') || '';
      summary.innerHTML = `已选 <strong>${selectedIds.length}</strong> / ${visibleIds.length} 个${itemLabel}`;
    }

    const clearBtn = toolbar.querySelector('[data-bulk-role="clear"]');
    if (clearBtn) clearBtn.style.display = selectedIds.length > 0 ? '' : 'none';

    const executeBtn = toolbar.querySelector('[data-bulk-role="execute"]');
    if (executeBtn) executeBtn.disabled = selectedIds.length === 0 || !(state.bulkActionConfigs[key] || []).length;
  });
}

async function runBulkDelete({ selectionKey, itemLabel, onDelete, onDone }) {
  const ids = getBulkSelectedIds(selectionKey);
  if (!ids.length) {
    toast(`请先选择要删除的${itemLabel}`, 'warn');
    return;
  }
  showModal(`批量删除${itemLabel}`, `<p>确定删除选中的 <strong>${ids.length}</strong> 个${itemLabel}？<br><span style="font-size:0.8rem;color:var(--clr-danger)">此操作不可恢复。</span></p>`, async () => {
    let success = 0;
    const failed = [];
    for (const id of ids) {
      try {
        await onDelete(id);
        success += 1;
      } catch (e) {
        failed.push({ id, error: e });
      }
    }
    getBulkSelection(selectionKey).clear();
    if (success > 0) {
      toast(`已删除 ${success} 个${itemLabel}`, 'success');
    }
    if (failed.length > 0) {
      toast(`${failed.length} 个${itemLabel}删除失败`, 'warn');
    }
    if (onDone) await onDone({ success, failed });
  });
}

function getPermanentMailboxUsage(mailboxes = state.mailboxes, account = state.account) {
  const knownCount = Number(account?.permanent_mailbox_count);
  if (Number.isFinite(knownCount) && knownCount >= 0) {
    return knownCount;
  }
  return (mailboxes || []).filter(mb => mb.is_permanent).length;
}

function getPermanentMailboxQuota(account = state.account) {
  if (account?.is_admin) return Infinity;
  const quota = Number(account?.permanent_mailbox_quota ?? 0);
  return Number.isFinite(quota) && quota > 0 ? quota : 0;
}

function getPermanentMailboxRemaining(mailboxes = state.mailboxes, account = state.account) {
  const quota = getPermanentMailboxQuota(account);
  if (!Number.isFinite(quota)) return Infinity;
  return Math.max(quota - getPermanentMailboxUsage(mailboxes, account), 0);
}

function applySiteBranding(siteTitle = getSiteTitle(), siteLogo = getSiteLogo(), siteSubtitle = getSiteSubtitle()) {
  const normalizedTitle = String(siteTitle || DEFAULT_SITE_TITLE).trim() || DEFAULT_SITE_TITLE;
  const normalizedLogo = String(siteLogo || DEFAULT_SITE_LOGO).trim() || DEFAULT_SITE_LOGO;
  const normalizedSubtitle = String(siteSubtitle || DEFAULT_SITE_SUBTITLE).trim() || DEFAULT_SITE_SUBTITLE;
  state.siteTitle = normalizedTitle;
  state.siteLogo = normalizedLogo;
  state.siteSubtitle = normalizedSubtitle;
  localStorage.setItem('tm_site_title', normalizedTitle);
  localStorage.setItem('tm_site_logo', normalizedLogo);
  localStorage.setItem('tm_site_subtitle', normalizedSubtitle);
  document.title = `${normalizedTitle} — ${SITE_TITLE_SUFFIX}`;
  document.querySelectorAll('[data-site-title]').forEach(node => {
    node.textContent = normalizedTitle;
  });
  document.querySelectorAll('[data-site-logo]').forEach(node => {
    node.textContent = normalizedLogo;
  });
  document.querySelectorAll('[data-site-subtitle]').forEach(node => {
    node.textContent = normalizedSubtitle;
  });
}

// ─── API 客户端 ─────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const shouldAttachAuth = opts.auth !== false;
  if (shouldAttachAuth && state.apiKey) headers['Authorization'] = `Bearer ${state.apiKey}`;

  const fetchOpts = { ...opts, method, headers };
  delete fetchOpts.auth;
  delete fetchOpts.retries;
  delete fetchOpts.retry;

  const retryable = opts.retry !== false && (method === 'GET' || method === 'HEAD');
  const maxRetries = Number.isInteger(opts.retries) ? Math.max(opts.retries, 0) : (retryable ? 2 : 0);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(path, fetchOpts);
      let data;
      try { data = await res.json(); } catch { data = {}; }
      if (!res.ok) {
        const rawMessage = data.error || data.message || `HTTP ${res.status}`;
        const error = new Error(isTemporaryRequestStatus(res.status) ? getTemporaryRequestMessage({ status: res.status, rawMessage }) : rawMessage);
        error.status = res.status;
        error.rawMessage = rawMessage;
        error.response = data;

        if (attempt < maxRetries && isTemporaryRequestStatus(res.status)) {
          const retryAfter = Number(res.headers.get('Retry-After') || '');
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 900 * (attempt + 1);
          await sleep(waitMs);
          continue;
        }
        throw error;
      }
      return data;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err || '请求失败'));
      const temporary = isTemporaryRequestError(error);
      if (attempt < maxRetries && retryable && temporary) {
        await sleep(900 * (attempt + 1));
        continue;
      }
      if (temporary) {
        error.message = getTemporaryRequestMessage(error);
      }
      throw error;
    }
  }

  throw new Error('请求失败');
}

const api = {
  // 公共
  publicSettings: () => apiFetch(PUBLIC_BASE + '/settings', { auth: false }),
  publicStats:     () => apiFetch(PUBLIC_BASE + '/stats', { auth: false }),
  register: body  => apiFetch(PUBLIC_BASE + '/register', { method: 'POST', body: JSON.stringify(body), auth: false }),

  // 账户
  me:              () => apiFetch(API_BASE + '/me'),
  stats:           () => apiFetch(API_BASE + '/stats'),
  // 域名 → 解包 {domains:[...]} → 数组
  domains:         () => apiFetch(API_BASE + '/domains').then(d => Array.isArray(d) ? d : (d.domains || [])),
  // 任意已登录用户提交域名 MX 验证
  submitDomain:    body => apiFetch(API_BASE + '/domains/submit', { method: 'POST', body: JSON.stringify(body) }),
  // 轮询域名状态（任意已登录用户，不需要管理员权限）
  getDomainStatus: id => apiFetch(API_BASE + '/domains/' + id + '/status'),
  // 邮箱 → 解包 {data:[...]}
  createMailbox:   (body) => apiFetch(API_BASE + '/mailboxes', { method: 'POST', body: JSON.stringify(body || {}) }),
  listMailboxesPage: (page = 1, size = DASHBOARD_MAILBOX_PAGE_SIZE, q = '', kind = 'all') =>
    apiFetch(withQuery(API_BASE + '/mailboxes', { page, size, q, kind })).then(d => normalizePaginatedResponse(d, page, size)),
  listMailboxes:   (page = 1, size = DASHBOARD_MAILBOX_PAGE_SIZE, q = '', kind = 'all') => api.listMailboxesPage(page, size, q, kind).then(d => d.data || []),
  deleteMailbox: id  => apiFetch(API_BASE + '/mailboxes/' + id, { method: 'DELETE' }),
  // 邮件 → 解包 {data:[...]}
  listEmailsPage: (mid, page = 1, size = INBOX_EMAIL_PAGE_SIZE, q = '') =>
    apiFetch(withQuery(API_BASE + '/mailboxes/' + mid + '/emails', { page, size, q })).then(d => normalizePaginatedResponse(d, page, size)),
  listEmails: (mid, page = 1, size = INBOX_EMAIL_PAGE_SIZE, q = '') => api.listEmailsPage(mid, page, size, q).then(d => d.data || []),
  getEmail:   (mid, eid) => apiFetch(API_BASE + '/mailboxes/' + mid + '/emails/' + eid).then(d => d.email || d),
  deleteEmail:(mid, eid) => apiFetch(API_BASE + '/mailboxes/' + mid + '/emails/' + eid, { method: 'DELETE' }),
  // 管理
  admin: {
    listAccountsPage:  (page = 1, size = ADMIN_ACCOUNT_PAGE_SIZE, q = '', role = 'all') =>
      apiFetch(withQuery(API_BASE + '/admin/accounts', { page, size, q, role })).then(d => normalizePaginatedResponse(d, page, size)),
    listAccounts:  (page = 1, size = ADMIN_ACCOUNT_PAGE_SIZE, q = '', role = 'all') => api.admin.listAccountsPage(page, size, q, role).then(d => d.data || []),
    listAllAccounts: async (size = ADMIN_ACCOUNT_PAGE_SIZE_OPTIONS[ADMIN_ACCOUNT_PAGE_SIZE_OPTIONS.length - 1]) => {
      const firstPage = await api.admin.listAccountsPage(1, size);
      const all = [...(firstPage.data || [])];
      for (let page = 2; page <= firstPage.totalPages; page += 1) {
        const nextPage = await api.admin.listAccountsPage(page, size);
        all.push(...(nextPage.data || []));
      }
      return all;
    },
    createAccount: body => apiFetch(API_BASE + '/admin/accounts', { method: 'POST', body: JSON.stringify(body) }),
    deleteAccount: id   => apiFetch(API_BASE + '/admin/accounts/' + id, { method: 'DELETE' }),
    toggleAccountAdmin: (id, is_admin) => apiFetch(API_BASE + '/admin/accounts/' + id + '/admin', { method: 'PUT', body: JSON.stringify({ is_admin }) }),
    setAccountQuota: (id, permanent_mailbox_quota) => apiFetch(API_BASE + '/admin/accounts/' + id + '/quota', { method: 'PUT', body: JSON.stringify({ permanent_mailbox_quota }) }),
    listCatchallMailboxesPage: (page = 1, size = CATCHALL_MAILBOX_PAGE_SIZE, q = '', owner = 'all') =>
      apiFetch(withQuery(API_BASE + '/admin/catchall/mailboxes', { page, size, q, owner })).then(d => normalizePaginatedResponse(d, page, size)),
    listCatchallMailboxes: (page = 1, size = CATCHALL_MAILBOX_PAGE_SIZE, q = '', owner = 'all') => api.admin.listCatchallMailboxesPage(page, size, q, owner).then(d => d.data || []),
    deleteCatchallMailbox: id => apiFetch(API_BASE + '/admin/catchall/mailboxes/' + id, { method: 'DELETE' }),
    listCatchallEmailsPage: (mid, page = 1, size = INBOX_EMAIL_PAGE_SIZE, q = '') =>
      apiFetch(withQuery(API_BASE + '/admin/catchall/mailboxes/' + mid + '/emails', { page, size, q })).then(d => normalizePaginatedResponse(d, page, size)),
    listCatchallEmails: (mid, page = 1, size = INBOX_EMAIL_PAGE_SIZE, q = '') => api.admin.listCatchallEmailsPage(mid, page, size, q).then(d => d.data || []),
    getCatchallEmail: (mid, eid) => apiFetch(API_BASE + '/admin/catchall/mailboxes/' + mid + '/emails/' + eid).then(d => d.email || d),
    deleteCatchallEmail: (mid, eid) => apiFetch(API_BASE + '/admin/catchall/mailboxes/' + mid + '/emails/' + eid, { method: 'DELETE' }),
    addDomain:   body => apiFetch(API_BASE + '/admin/domains', { method: 'POST', body: JSON.stringify(body) }),
    deleteDomain:  id => apiFetch(API_BASE + '/admin/domains/' + id, { method: 'DELETE' }),
    toggleDomain:  (id, active) => apiFetch(API_BASE + '/admin/domains/' + id + '/toggle', { method: 'PUT', body: JSON.stringify({ active }) }),
    getSettings:    () => apiFetch(API_BASE + '/admin/settings'),
    saveSettings: body => apiFetch(API_BASE + '/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    mxImport:    body => apiFetch(API_BASE + '/admin/domains/mx-import', { method: 'POST', body: JSON.stringify(body) }),
    mxRegister:  body => apiFetch(API_BASE + '/admin/domains/mx-register', { method: 'POST', body: JSON.stringify(body) }),
    getDomainStatus: id => apiFetch(API_BASE + '/admin/domains/' + id + '/status'),
  },
};

async function loadPublicSettings(force = false) {
  if (!force && state.publicSettings) {
    applySiteBranding(
      state.publicSettings.site_title,
      state.publicSettings.site_logo,
      state.publicSettings.site_subtitle,
    );
    return state.publicSettings;
  }
  try {
    const settings = await api.publicSettings();
    state.publicSettings = settings || {};
    applySiteBranding(
      state.publicSettings.site_title,
      state.publicSettings.site_logo,
      state.publicSettings.site_subtitle,
    );
    return state.publicSettings;
  } catch {
    state.publicSettings = state.publicSettings || {};
    applySiteBranding();
    return state.publicSettings;
  }
}

// ─── 主题 ────────────────────────────────────────────────────
const themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const THEME_ORDER = ['system', 'light', 'dark'];

function getEffectiveTheme(mode = state.theme) {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return themeMedia && themeMedia.matches ? 'dark' : 'light';
}

function getThemeButtonLabel(mode = state.theme) {
  switch (mode) {
    case 'dark': return '☾ 深色模式';
    case 'light': return '☀ 浅色模式';
    default: return '◐ 跟随系统';
  }
}

function getThemeButtonTitle(mode = state.theme) {
  const effective = getEffectiveTheme(mode) === 'dark' ? '深色' : '浅色';
  return `当前主题：${getThemeButtonLabel(mode).replace(/^[^\s]+\s*/, '')}（实际生效：${effective}）\n点击可切换为下一种模式`;
}

function refreshThemeButton() {
  document.querySelectorAll('[data-role="theme-toggle"]').forEach(btn => {
    btn.textContent = getThemeButtonLabel(state.theme);
    btn.title = getThemeButtonTitle(state.theme);
  });
}

function applyTheme(mode, { persist = true } = {}) {
  const effective = getEffectiveTheme(mode);
  document.documentElement.dataset.theme = effective;
  document.documentElement.style.colorScheme = effective;
  state.theme = mode;
  if (persist) localStorage.setItem('tm_theme', mode);
  refreshThemeButton();
}

if (themeMedia) {
  const syncSystemTheme = () => {
    if (state.theme === 'system') applyTheme('system', { persist: false });
  };
  if (typeof themeMedia.addEventListener === 'function') {
    themeMedia.addEventListener('change', syncSystemTheme);
  } else if (typeof themeMedia.addListener === 'function') {
    themeMedia.addListener(syncSystemTheme);
  }
}

// ─── 认证 ─────────────────────────────────────────────────────
async function tryLogin(key) {
  state.apiKey = key;
  try {
    const acct = await apiFetch(API_BASE + '/me');
    state.account = acct;
    localStorage.setItem('tm_apikey', key);
    localStorage.setItem('tm_account', JSON.stringify(acct));
    showMainLayout();
    navigate('dashboard');
    toast(`欢迎回来，${acct.username || '用户'}`, 'success');
  } catch (e) {
    const isAuthFailure = [401, 403].includes(Number(e?.status || 0));
    if (isAuthFailure) {
      state.apiKey = '';
      toast('API Key 无效: ' + getDisplayErrorMessage(e), 'error');
      return;
    }
    toast('登录失败: ' + getDisplayErrorMessage(e), isTemporaryRequestError(e) ? 'warn' : 'error');
  }
}

function logout() {
  clearInboxPoller();
  clearPendingDomainPoller();
  state.apiKey = '';
  state.account = null;
  localStorage.removeItem('tm_apikey');
  localStorage.removeItem('tm_account');
  showAuthPage();
}

// ─── 路由 ─────────────────────────────────────────────────────
function navigate(page, params = {}) {
  closeSidebar();
  // 离开收件箱时停止自动刷新
  if (page !== 'inbox') clearInboxPoller();
  if (!['domains-guide', 'admin-domains'].includes(page)) clearPendingDomainPoller();
  state.page = page;
  Object.assign(state, params);
  renderPage(page);
  // 更新侧导航高亮
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });
}

// ─── 布局渲染 ──────────────────────────────────────────────────
function showAuthPage() {
  clearInboxPoller();
  clearPendingDomainPoller();
  $('app').innerHTML = '';
  $('app').appendChild(buildAuthPage());
  applyTheme(state.theme, { persist: false });
  applySiteBranding();
  renderLoginForm();
}

function showMainLayout() {
  $('app').innerHTML = '';
  $('app').appendChild(buildMainLayout());
  applyTheme(state.theme, { persist: false });
  applySiteBranding();
}

function buildAuthPage() {
  const wrap = el('div', null);
  wrap.id = 'auth-page';

  const quickActions = el('div', 'auth-floating-actions');
  quickActions.innerHTML = `
    <button class="btn-theme auth-theme-btn" id="btn-theme-auth" data-role="theme-toggle" onclick="toggleTheme()">${getThemeButtonLabel(state.theme)}</button>
  `;
  wrap.appendChild(quickActions);

  const card = el('div', 'auth-card');
  card.innerHTML = `
    <div class="auth-logo">
      <div class="logo-icon" data-site-logo>${escHtml(getSiteLogo())}</div>
      <h1 data-site-title>${escHtml(getSiteTitle())}</h1>
      <p data-site-subtitle>${escHtml(getSiteSubtitle())}</p>
    </div>
    <div class="auth-tabs">
      <button class="auth-tab active" id="tab-login" onclick="switchAuthTab('login')">使用 API Key 登录</button>
      <button class="auth-tab" id="tab-reg" onclick="switchAuthTab('reg')">注册账户</button>
    </div>
    <div id="auth-form-area"></div>
  `;
  wrap.appendChild(card);

  // 检查是否允许注册
  loadPublicSettings().then(d => {
    const open = d.registration_open === 'true' || d.registration_open === true;
    if (!open) {
      const regTab = card.querySelector('#tab-reg');
      if (regTab) { regTab.disabled = true; regTab.title = '管理员已关闭注册'; }
    }
  }).catch(() => {});

  return wrap;
}

window.switchAuthTab = function(t) {
  document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
  if (t === 'login') {
    $('tab-login').classList.add('active');
    renderLoginForm();
  } else {
    $('tab-reg').classList.add('active');
    renderRegForm();
  }
};

function renderLoginForm() {
  const area = $('auth-form-area');
  if (!area) return;
  area.innerHTML = `
    <div class="form-group">
      <label class="form-label">API Key</label>
      <input class="form-input" id="login-key" type="password" placeholder="tm_xxxxxxxxxxxx" autocomplete="current-password" />
      <div class="form-hint">在邮箱管理后台获取的 API Key</div>
    </div>
    <button class="btn btn-primary" style="width:100%" onclick="doLogin()">登 录</button>
    <div class="divider"></div>
    <div style="text-align:center;font-size:0.78rem;color:var(--text-muted)">
      没有账户？联系管理员创建，或点击上方"注册账户"
    </div>
  `;
  const inp = $('login-key');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}

function renderRegForm() {
  const area = $('auth-form-area');
  if (!area) return;
  area.innerHTML = `
    <div class="form-group">
      <label class="form-label">用户名</label>
      <input class="form-input" id="reg-username" type="text" placeholder="your_name" />
    </div>
    <div class="form-group">
      <label class="form-label">邮箱（可选）</label>
      <input class="form-input" id="reg-email" type="email" placeholder="contact@example.com" />
    </div>
    <button class="btn btn-primary" style="width:100%" onclick="doRegister()">注 册</button>
  `;
}

window.doLogin = async function() {
  const key = ($('login-key')?.value || '').trim();
  if (!key) { toast('请输入 API Key', 'warn'); return; }
  await tryLogin(key);
};

window.doRegister = async function() {
  const username = ($('reg-username')?.value || '').trim();
  const email    = ($('reg-email')?.value || '').trim();
  if (!username) { toast('请输入用户名', 'warn'); return; }
  try {
    const result = await api.register({ username, email: email || undefined });
    // 显示成功
    const area = $('auth-form-area');
    area.innerHTML = `
      <div class="apikey-hero">
        <span class="big-icon">🎉</span>
        <h2>注册成功！</h2>
        <p>请保存您的 API Key，它不会再次显示。</p>
        <div class="code-box">
          <span id="new-key">${escHtml(result.api_key)}</span>
          <button class="copy-btn" onclick="copyText('${escHtml(result.api_key)}')" title="复制">⎘</button>
        </div>
        <button class="btn btn-success" style="margin-top:1.2rem;width:100%" onclick="tryLogin('${escHtml(result.api_key)}')">立即登录</button>
      </div>
    `;
  } catch(e) {
    toast('注册失败: ' + e.message, 'error');
  }
};

// ─── 主布局 ────────────────────────────────────────────────────
function buildMainLayout() {
  const layout = el('div', null);
  layout.id = 'main-layout';
  layout.style.display = 'flex';
  layout.style.flex = '1';

  const isAdmin = state.account?.is_admin;
  const username = state.account?.username || '用户';

  // sidebar
  layout.innerHTML = `
    <div class="sidebar-backdrop" id="sidebar-backdrop" onclick="closeSidebar()"></div>
    <nav class="sidebar" id="main-sidebar">
      <div class="sidebar-logo">
        <div class="logo-mark" data-site-logo>${escHtml(getSiteLogo())}</div>
        <div>
          <span data-site-title>${escHtml(getSiteTitle())}</span>
          <small data-site-subtitle>${escHtml(getSiteSubtitle())}</small>
        </div>
      </div>
      <div class="sidebar-nav">
        <div class="nav-section">邮件</div>
        <button class="nav-item active" data-page="dashboard" onclick="navigate('dashboard')">
          <span class="nav-icon">⊞</span><span>邮箱总览</span>
        </button>
        <button class="nav-item" data-page="domains-guide" onclick="navigate('domains-guide')">
          <span class="nav-icon">◎</span><span>域名列表</span>
        </button>
        <button class="nav-item" data-page="api-docs" onclick="navigate('api-docs')">
          <span class="nav-icon">📖</span><span>API 文档</span>
        </button>
        ${isAdmin ? `
        <div class="nav-section">管理</div>
        <button class="nav-item" data-page="admin-accounts" onclick="navigate('admin-accounts')">
          <span class="nav-icon">👥</span><span>账户管理</span>
        </button>
        <button class="nav-item" data-page="admin-catchall" onclick="navigate('admin-catchall')">
          <span class="nav-icon">📥</span><span>Catch-all 收件箱</span>
        </button>
        <button class="nav-item" data-page="admin-domains" onclick="navigate('admin-domains')">
          <span class="nav-icon">🌐</span><span>域名管理</span>
        </button>
        <button class="nav-item" data-page="admin-settings" onclick="navigate('admin-settings')">
          <span class="nav-icon">⚙</span><span>系统设置</span>
        </button>
        ` : ''}
      </div>
      <div class="sidebar-bottom">
        <div class="user-chip">
          <div class="user-avatar">${username.charAt(0).toUpperCase()}</div>
          <div class="user-chip-info">
            <div class="user-chip-name">${escHtml(username)}</div>
            <div class="user-chip-role">${isAdmin ? '管理员' : '普通用户'}</div>
          </div>
        </div>
        <button class="btn-logout" onclick="logout()">⏏ 退出登录</button>
        <button class="btn-theme" id="btn-theme" data-role="theme-toggle" onclick="toggleTheme()">${getThemeButtonLabel(state.theme)}</button>
      </div>
    </nav>
    <div class="content" id="content-area">
      <div class="topbar">
        <div>
          <button class="hamburger-btn" id="hamburger-btn" onclick="toggleSidebar()" aria-label="菜单">☰</button>
          <div>
            <div class="topbar-title" id="topbar-title">邮箱总览</div>
            <div class="topbar-subtitle" id="topbar-subtitle"></div>
          </div>
        </div>
        <div id="topbar-actions"></div>
      </div>
      <div id="page-content" class="page"></div>
    </div>
  `;
  return layout;
}

window.toggleTheme = function() {
  const idx = THEME_ORDER.indexOf(state.theme);
  const nextTheme = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
  applyTheme(nextTheme);
};
window.navigate = navigate;
window.logout   = logout;
window.copyText = copyText;
window.tryLogin = tryLogin;

window.toggleSidebar = function() {
  const sidebar  = document.getElementById('main-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar) return;
  const isOpen = sidebar.classList.contains('mob-open');
  if (isOpen) {
    sidebar.classList.remove('mob-open');
    if (backdrop) backdrop.classList.remove('show');
  } else {
    sidebar.classList.add('mob-open');
    if (backdrop) backdrop.classList.add('show');
  }
};

window.closeSidebar = function() {
  const sidebar  = document.getElementById('main-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (sidebar)  sidebar.classList.remove('mob-open');
  if (backdrop) backdrop.classList.remove('show');
};

// ─── 页面渲染路由 ───────────────────────────────────────────
async function renderPage(page) {
  const container = $('page-content');
  if (!container) return;
  container.innerHTML = '<div style="padding:2rem;text-align:center"><span class="spinner"></span></div>';

  const titles = {
    'dashboard':      ['邮箱总览', '管理您的临时邮箱'],
    'inbox':          ['邮件列表', ''],
    'email-view':     ['邮件内容', ''],
    'domains-guide':  ['域名列表 & 添加指南', '查看可用域名并了解如何添加新域名'],
    'admin-accounts': ['账户管理', '创建和管理用户账户'],
    'admin-catchall': ['Catch-all 收件箱', '查看未预创建地址收到的邮件'],
    'admin-domains':  ['域名管理', '管理域名池'],
    'admin-settings': ['系统设置', ''],
    'apikey-show':    ['API Key', ''],
    'api-docs':       ['API 接口文档', '查看所有可用 API 及调用示例'],
  };
  const [t, s] = titles[page] || ['—', ''];
  const title = $('topbar-title'); if (title) title.textContent = t;
  const sub   = $('topbar-subtitle'); if (sub) sub.textContent = s;
  const actions = $('topbar-actions'); if (actions) actions.innerHTML = '';

  try {
    switch(page) {
      case 'dashboard':      await renderDashboard(container); break;
      case 'inbox':          await renderInbox(container); break;
      case 'email-view':     await renderEmailView(container); break;
      case 'domains-guide':  await renderDomainsGuide(container); break;
      case 'admin-accounts': await renderAdminAccounts(container); break;
      case 'admin-catchall': await renderAdminCatchall(container); break;
      case 'admin-domains':  await renderAdminDomains(container); break;
      case 'admin-settings': await renderAdminSettings(container); break;
      case 'apikey-show':    renderApiKeyShow(container); break;
      case 'api-docs':       renderApiDocs(container); break;
      default: container.innerHTML = '<div class="page"><p>页面未找到</p></div>';
    }
  } catch(e) {
    const msg = getDisplayErrorMessage(e);
    if (isTemporaryRequestError(e)) {
      container.innerHTML = `
        <div class="card">
          <div class="empty-state">
            <span class="empty-icon">⏳</span>
            <p>服务正在恢复中</p>
            <p style="margin-top:0.5rem;font-size:0.82rem">${escHtml(msg)}</p>
            <button class="btn btn-primary btn-sm" style="margin-top:1rem" onclick="retryCurrentPage()">重新加载</button>
          </div>
        </div>
      `;
      return;
    }
    container.innerHTML = `<div style="padding:2rem;color:var(--clr-danger)">加载失败：${escHtml(msg)}</div>`;
  }
}

window.retryCurrentPage = function() {
  renderPage(state.page);
};

window.applyListSearch = function(key, field = 'q') {
  const input = document.getElementById(getListSearchInputId(key, field));
  const value = (input?.value || '').trim();
  updateListViewState(key, { [field]: value, page: 1 });
  resetRelatedListPages(key);
  renderPage(state.page);
};

window.handleListSearchKeydown = function(event, key, field = 'q') {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  window.applyListSearch(key, field);
};

window.setListViewField = function(key, field, value) {
  updateListViewState(key, { [field]: value, page: 1 });
  resetRelatedListPages(key);
  renderPage(state.page);
};

window.resetListViewFilters = function(key) {
  const current = getListViewState(key);
  const defaults = {
    ...(current?.__defaults || {}),
    page: 1,
    size: current?.size || current?.__defaults?.size || DEFAULT_PAGE_SIZE,
  };
  state.listViews[key] = { ...defaults, __defaults: defaults };
  resetRelatedListPages(key);
  renderPage(state.page);
};

window.setListPage = function(key, page) {
  const current = getListViewState(key);
  const nextPage = Math.max(1, Number(page) || 1);
  if (nextPage === current.page) return;
  current.page = nextPage;
  renderPage(state.page);
};

window.setListPageSize = function(key, size) {
  const nextSize = Number(size);
  if (!Number.isFinite(nextSize) || nextSize < 1) {
    toast('无效的每页数量', 'warn');
    return;
  }
  const current = getListViewState(key, { page: 1, size: nextSize });
  if (current.size === nextSize) return;
  current.size = nextSize;
  current.page = 1;
  renderPage(state.page);
};

window.setDashboardMailboxPage = function(page) {
  window.setListPage('dashboard-mailboxes', page);
};

window.setDashboardMailboxPageSize = function(size) {
  window.setListPageSize('dashboard-mailboxes', size);
};

// ─── Dashboard ─────────────────────────────────────────────
async function renderDashboard(container) {
  const bulkKey = 'dashboard-mailboxes';
  const listKey = 'dashboard-mailboxes';
  const isAdmin = state.account?.is_admin;
  const listState = getListViewState(listKey, {
    page: 1,
    size: DASHBOARD_MAILBOX_PAGE_SIZE,
    q: '',
    kind: 'all',
  });
  const currentPage = Math.max(1, Number(listState.page) || 1);
  const pageSize = DASHBOARD_MAILBOX_PAGE_SIZE_OPTIONS.includes(Number(listState.size))
    ? Number(listState.size)
    : DASHBOARD_MAILBOX_PAGE_SIZE;
  const query = String(listState.q || '').trim();
  const kind = ['all', 'permanent', 'temporary', 'catchall'].includes(String(listState.kind || 'all'))
    ? String(listState.kind || 'all')
    : 'all';
  const [mailboxPage, domains, statsData, accountData] = await Promise.all([
    api.listMailboxesPage(currentPage, pageSize, query, kind),
    api.domains(),
    api.stats().catch(() => null),
    api.me().catch(() => state.account),
  ]);
  if (currentPage > mailboxPage.totalPages) {
    updateListViewState(listKey, { page: mailboxPage.totalPages }, {
      page: 1,
      size: DASHBOARD_MAILBOX_PAGE_SIZE,
      q: '',
      kind: 'all',
    });
    return renderDashboard(container);
  }
  if (accountData) {
    state.account = accountData;
    localStorage.setItem('tm_account', JSON.stringify(accountData));
  }
  const currentAccount = state.account || accountData || null;
  updateListViewState(listKey, {
    page: mailboxPage.page,
    size: mailboxPage.size,
    q: query,
    kind,
  }, {
    page: 1,
    size: DASHBOARD_MAILBOX_PAGE_SIZE,
    q: '',
    kind: 'all',
  });
  state.mailboxes = mailboxPage.data || [];
  setBulkVisibleIds(bulkKey, state.mailboxes.map(mb => mb.id));

  const actions = $('topbar-actions');
  if (actions) {
    actions.innerHTML = `
      <button class="btn btn-primary btn-sm" onclick="createMailbox()">+ 新建邮箱</button>
      <button class="btn btn-ghost btn-sm" onclick="navigate('apikey-show')" style="margin-left:0.4rem">⚿ 我的 API Key</button>
    `;
  }

  const boxes  = state.mailboxes;
  const totalMailboxes = Number(mailboxPage.total || 0);
  const st     = statsData || {};
  const activeDomains  = (domains||[]).filter(d => d.is_active).length;
  const pendingDomains = (domains||[]).filter(d => d.status === 'pending').length;
  const permanentUsed = getPermanentMailboxUsage(boxes, currentAccount);
  const permanentQuota = getPermanentMailboxQuota(currentAccount);
  const permanentRemaining = getPermanentMailboxRemaining(boxes, currentAccount);

  const statCards = [
    { label: '我的邮箱', value: totalMailboxes,                 note: mailboxPage.totalPages > 1 ? `第 ${mailboxPage.page} / ${mailboxPage.totalPages} 页` : '当前有效' },
    { label: '永久邮箱', value: permanentUsed,                  note: Number.isFinite(permanentQuota) ? `剩余 ${permanentRemaining} / 总额 ${permanentQuota}` : '管理员无限制' },
    { label: '可用域名', value: activeDomains,                  note: `共 ${(domains||[]).length} 个` },
    { label: '收到邮件', value: st.total_emails ?? '—',         note: '全平台累计' },
    { label: '邮箱总量', value: st.total_mailboxes ?? '—',      note: `活跃 ${st.active_mailboxes ?? '—'} 个` },
    ...(isAdmin ? [
      { label: '账户总数', value: st.total_accounts ?? '—',       note: '注册用户' },
      { label: '待验证域名', value: st.pending_domains ?? pendingDomains, note: pendingDomains > 0 ? '🔄 验证中' : '无' },
    ] : []),
  ];

  // 公告栏
  const announcement = (await api.publicSettings().catch(() => ({}))).announcement || '';

  container.innerHTML = `
    ${announcement ? `<div class="card" style="margin-bottom:1rem;background:var(--clr-primary,#4f6ef7);color:#fff;padding:0.7rem 1rem;font-size:0.84rem">
      📢 ${escHtml(announcement)}</div>` : ''}
    <div class="stat-grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))">
      ${statCards.map(s => `
        <div class="stat-card">
          <div class="stat-label">${escHtml(s.label)}</div>
          <div class="stat-value">${typeof s.value === 'number' ? s.value.toLocaleString() : s.value}</div>
          <div class="stat-note">${escHtml(s.note)}</div>
        </div>
      `).join('')}
    </div>
    ${pendingDomains > 0 ? `
      <div class="card" style="margin-top:0.8rem;border-left:3px solid var(--clr-warn,#e6a817)">
        <div style="font-size:0.82rem">🔄 有 ${pendingDomains} 个域名正在 MX 验证中，通过后将自动加入域名池</div>
      </div>
    ` : ''}
    ${buildListFilterBar({
      key: listKey,
      searchValue: query,
      searchPlaceholder: '搜索邮箱地址，例如 hello@example.com',
      searchButtonLabel: '搜索邮箱',
      filters: [
        {
          field: 'kind',
          label: '类型',
          value: kind,
          options: [
            { value: 'all', label: '全部邮箱' },
            { value: 'permanent', label: '仅永久' },
            { value: 'temporary', label: '仅临时' },
            { value: 'catchall', label: '仅 Catch-all' },
          ],
        },
      ],
      hint: '永久邮箱已按置顶模式排序，搜索和筛选会作用于整个邮箱列表。',
    })}
    ${boxes.length === 0 ? `
      <div class="card" style="margin-top:0.8rem">
        <div class="empty-state">
          <span class="empty-icon">✉</span>
          <p>${query || kind !== 'all' ? '没有匹配当前筛选条件的邮箱' : '还没有邮箱，点击右上角"新建邮箱"创建第一个'}</p>
        </div>
      </div>
    ` : `
      ${buildBulkToolbar({
        key: bulkKey,
        itemLabel: '邮箱',
        actions: [
          { value: 'delete', label: '删除选中邮箱', run: () => window.bulkDeleteMailboxes(bulkKey) },
        ],
        scopeHint: '当前批量操作仅对本页邮箱生效，翻页后会自动切换到新页面的可见列表。',
      })}
      <div class="mailbox-grid" id="mailbox-grid" style="margin-top:0.8rem">
        ${boxes.map(mb => buildMailboxCard(mb, bulkKey)).join('')}
      </div>
      ${buildPaginationBar({
        page: mailboxPage.page,
        size: mailboxPage.size,
        total: totalMailboxes,
        totalPages: mailboxPage.totalPages,
        itemLabel: '邮箱',
        pageSizeOptions: DASHBOARD_MAILBOX_PAGE_SIZE_OPTIONS,
        onPageChange: 'setListPage',
        onPageSizeChange: 'setListPageSize',
        pagerKey: listKey,
      })}
    `}
  `;
}

function buildMailboxCard(mb, bulkKey = 'dashboard-mailboxes') {
  const expiresAt = mb.expires_at ? new Date(mb.expires_at) : null;
  const now = new Date();
  let expiryHtml = '';
  const permanentHtml = mb.is_permanent
    ? `<span class="badge badge-green" style="font-size:0.72rem">永久</span>`
    : '';
  const catchallHtml = mb.is_catchall
    ? `<span class="badge badge-gray" style="font-size:0.72rem">Catch-all</span>`
    : '';
  if (mb.is_permanent) {
    expiryHtml = '<span style="color:var(--clr-success);font-size:0.75rem">♾ 永久保留</span>';
  } else if (expiresAt) {
    const diffMs = expiresAt - now;
    if (diffMs <= 0) {
      expiryHtml = '<span style="color:var(--clr-danger);font-size:0.75rem">⏱ 已过期</span>';
    } else {
      const mins = Math.ceil(diffMs / 60000);
      const color = mins <= 5 ? 'var(--clr-danger)' : mins <= 15 ? 'var(--clr-warn,#e6a817)' : 'var(--text-muted)';
      expiryHtml = `<span style="color:${color};font-size:0.75rem">⏱ ${mins}分钟后删除</span>`;
    }
  }
  return `
    <div class="mailbox-card" onclick="openInbox('${mb.id}','${escHtml(mb.full_address)}')">
      <div class="mailbox-address" style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap">
        <label style="display:flex;align-items:center;cursor:pointer" onclick="event.stopPropagation()">
          <input type="checkbox" data-bulk-key="${bulkKey}" data-bulk-id="${mb.id}" ${isBulkSelected(bulkKey, mb.id) ? 'checked' : ''} onchange="toggleBulkSelection('${bulkKey}','${mb.id}', this.checked)">
        </label>
        <span>${escHtml(mb.full_address)}</span>
        ${permanentHtml}
        ${catchallHtml}
      </div>
      <div class="mailbox-stats" style="display:flex;gap:0.7rem;align-items:center">
        <span>创建于 ${formatDate(mb.created_at)}</span>
        ${expiryHtml}
      </div>
      <div class="mailbox-actions">
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openInbox('${mb.id}','${escHtml(mb.full_address)}')">📬 查看邮件</button>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();copyText('${escHtml(mb.full_address)}')" title="复制地址">⎘</button>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();confirmDeleteMailbox('${mb.id}','${escHtml(mb.full_address)}')">✕</button>
      </div>
    </div>
  `;
}

window.bulkDeleteMailboxes = async function(selectionKey = 'dashboard-mailboxes') {
  await runBulkDelete({
    selectionKey,
    itemLabel: '邮箱',
    onDelete: id => api.deleteMailbox(id),
    onDone: async () => navigate('dashboard'),
  });
};

function isAdminCatchallScope(mb = state.currentMailbox) {
  return mb?.scope === 'admin-catchall';
}

function getMailboxBackPage(mb = state.currentMailbox) {
  return isAdminCatchallScope(mb) ? 'admin-catchall' : 'dashboard';
}

function getInboxListViewKey(mb = state.currentMailbox) {
  if (!mb?.id) return 'inbox-list-unknown';
  return `inbox-list-${mb.scope || 'regular'}-${mb.id}`;
}

async function listEmailsPageForMailbox(mb = state.currentMailbox, page = 1, size = INBOX_EMAIL_PAGE_SIZE, q = '') {
  if (!mb) return normalizePaginatedResponse([], page, size);
  return isAdminCatchallScope(mb)
    ? api.admin.listCatchallEmailsPage(mb.id, page, size, q)
    : api.listEmailsPage(mb.id, page, size, q);
}

async function listEmailsForMailbox(mb = state.currentMailbox, page = 1, size = INBOX_EMAIL_PAGE_SIZE, q = '') {
  const result = await listEmailsPageForMailbox(mb, page, size, q);
  return result?.data || [];
}

async function getEmailForMailbox(eid, mb = state.currentMailbox) {
  if (!mb) return null;
  return isAdminCatchallScope(mb)
    ? api.admin.getCatchallEmail(mb.id, eid)
    : api.getEmail(mb.id, eid);
}

async function deleteEmailForMailbox(eid, mb = state.currentMailbox) {
  if (!mb) return null;
  return isAdminCatchallScope(mb)
    ? api.admin.deleteCatchallEmail(mb.id, eid)
    : api.deleteEmail(mb.id, eid);
}

window.openInbox = function(id, addr, scope = 'regular') {
  updateListViewState(`inbox-list-${scope || 'regular'}-${id}`, { page: 1, q: '' }, { page: 1, size: INBOX_EMAIL_PAGE_SIZE, q: '' });
  state.currentMailbox = { id, full_address: addr, scope };
  navigate('inbox');
};

window.createMailbox = async function() {
  // 拉取活跃域名列表，构建选择弹窗
  let activeDomains = [];
  try {
    const all = await api.domains();
    activeDomains = (all || []).filter(d => d.is_active);
  } catch(e) { /* 获取失败时退化为随机域名 */ }

  const old = document.querySelector('.modal-overlay');
  if (old) old.remove();
  const overlay = el('div', 'modal-overlay');
  const isAdmin = !!state.account?.is_admin;
  const permanentUsed = getPermanentMailboxUsage(state.mailboxes);
  const permanentQuota = getPermanentMailboxQuota(state.account);
  const permanentRemaining = getPermanentMailboxRemaining(state.mailboxes, state.account);
  const permanentDisabled = !isAdmin && permanentRemaining <= 0;
  const { exact: exactDomains, wildcard: wildcardDomains } = splitManagedDomains(activeDomains);

  const domainOptions = exactDomains.map(d =>
    `<option value="${escHtml(d.domain)}">${escHtml(d.domain)}</option>`
  ).join('');
  const wildcardHint = wildcardDomains.length > 0
    ? `已启用通配域名规则：${wildcardDomains.map(d => `<code>${escHtml(d.domain)}</code> → 例如 <code>${escHtml(getWildcardDomainExample(d.domain))}</code>`).join('；')}。`
    : '若后续添加了通配域名（如 *.example.com），请在下方输入真实子域名，例如 inbox.example.com。';
  const customDomainPlaceholder = wildcardDomains[0]
    ? getWildcardDomainExample(wildcardDomains[0].domain)
    : 'inbox.example.com';
  const wildcardOptions = wildcardDomains.map(d =>
    `<option value="${escHtml(d.domain)}">${escHtml(d.domain)}（基于 ${escHtml(getWildcardBaseDomain(d.domain))} 分配真实子域）</option>`
  ).join('');
  const wildcardModeOptions = `
    <option value="random">完全随机</option>
    <option value="wordlist">词库随机（可后台编辑）</option>
    <option value="custom">自定义</option>
  `;
  const wildcardQuickFillHtml = wildcardDomains.length > 0 ? `
    <div class="form-group">
      <label class="form-label">通配规则快捷示例</label>
      <div class="domain-quick-list">
        ${wildcardDomains.map(d => `
          <button type="button" class="domain-quick-btn" data-fill-domain="${escHtml(getWildcardDomainExample(d.domain))}">
            <span class="domain-quick-title">${escHtml(d.domain)}</span>
            <span class="domain-quick-note">填入 ${escHtml(getWildcardDomainExample(d.domain))}</span>
          </button>
        `).join('')}
      </div>
      <div class="form-hint">点一下即可把示例子域填入上面的“指定实际收件域名”输入框，再按需修改前缀。</div>
    </div>
  ` : '';

  overlay.innerHTML = `
    <div class="modal" style="max-width:500px">
      <div class="modal-title">+ 新建邮箱</div>
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      <div class="form-group" style="margin-top:0.8rem">
        <label class="form-label">本地部分（@ 之前）</label>
        <input class="form-input" id="mb-address" placeholder="留空则随机生成" autocomplete="off" />
        <div class="form-hint">只允许小写字母、数字、连字符、下划线。部分系统地址（如 admin / noreply / postmaster）仅管理员可创建。</div>
      </div>
      <div class="form-group">
        <label class="form-label">精确域名（可选）</label>
        <select class="form-input" id="mb-domain">
          <option value="">随机选取${exactDomains.length === 0 ? '（当前无精确域名）' : ''}</option>
          ${domainOptions}
        </select>
        <div class="form-hint">这里只显示可直接选取的精确域名；通配域名规则不会直接出现在下拉框中。</div>
      </div>
      <div class="form-group">
        <label class="form-label">指定实际收件域名（可选，优先级更高）</label>
        <input class="form-input" id="mb-domain-custom" placeholder="${escHtml(customDomainPlaceholder)}" autocomplete="off" />
        <div class="form-hint">${wildcardHint} 留空时会使用上面的精确域名选择或随机分配。</div>
      </div>
      ${wildcardDomains.length > 0 ? `
        <div class="form-group">
          <label class="form-label">或选择通配规则生成 / 指定子域</label>
          <select class="form-input" id="mb-domain-wildcard">
            <option value="">不自动生成</option>
            ${wildcardOptions}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">通配子域模式</label>
          <select class="form-input" id="mb-domain-wildcard-mode">
            ${wildcardModeOptions}
          </select>
          <div class="form-hint" id="mb-domain-wildcard-hint">默认会调用 <code>auto_subdomain=true</code> 并完全随机生成真实子域。</div>
        </div>
        <div class="form-group" id="mb-domain-wildcard-custom-wrap" style="display:none">
          <label class="form-label">自定义子域前缀 / 实际域名</label>
          <input class="form-input" id="mb-domain-wildcard-custom" placeholder="如 inbox 或 team.mail" autocomplete="off" />
          <div class="form-hint" id="mb-domain-wildcard-custom-hint">输入 <code>inbox</code> 会自动拼成 <code>inbox.example.com</code>；也可直接输入完整域名。</div>
        </div>
      ` : ''}
      ${wildcardQuickFillHtml}
      <div class="form-group">
        <label class="form-label" style="display:flex;align-items:center;gap:0.45rem">
          <input type="checkbox" id="mb-permanent" ${permanentDisabled ? 'disabled' : ''} />
          创建为永久邮箱
        </label>
        <div class="form-hint">
          ${isAdmin
            ? '管理员可创建无限个永久邮箱；永久邮箱不会自动过期。'
            : `当前已使用 ${permanentUsed}/${permanentQuota} 个永久邮箱额度，剩余 ${permanentRemaining} 个。${permanentDisabled ? '额度已用完，可继续创建临时邮箱。' : ''}`}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">取消</button>
        <button class="btn btn-primary" id="mb-confirm-btn">创建</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  // 回车确认
  const addressInput = overlay.querySelector('#mb-address');
  addressInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') overlay.querySelector('#mb-confirm-btn').click();
  });
  overlay.querySelector('#mb-domain-custom').addEventListener('keydown', e => {
    if (e.key === 'Enter') overlay.querySelector('#mb-confirm-btn').click();
  });
  const exactSelect = overlay.querySelector('#mb-domain');
  const customDomainInput = overlay.querySelector('#mb-domain-custom');
  const wildcardSelect = overlay.querySelector('#mb-domain-wildcard');
  const wildcardModeSelect = overlay.querySelector('#mb-domain-wildcard-mode');
  const wildcardHintEl = overlay.querySelector('#mb-domain-wildcard-hint');
  const wildcardCustomWrap = overlay.querySelector('#mb-domain-wildcard-custom-wrap');
  const wildcardCustomInput = overlay.querySelector('#mb-domain-wildcard-custom');
  const wildcardCustomHintEl = overlay.querySelector('#mb-domain-wildcard-custom-hint');

  wildcardCustomInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') overlay.querySelector('#mb-confirm-btn').click();
  });

  function refreshWildcardModeUi() {
    const selectedMode = wildcardModeSelect?.value || 'random';
    if (wildcardCustomWrap) {
      wildcardCustomWrap.style.display = selectedMode === 'custom' ? '' : 'none';
    }
    if (wildcardCustomInput) {
      wildcardCustomInput.disabled = selectedMode !== 'custom';
    }
  }

  function refreshWildcardHint() {
    if (!wildcardHintEl) return;
    const selectedRule = wildcardSelect?.value || '';
    const selectedMode = wildcardModeSelect?.value || 'random';
    if (!selectedRule) {
      wildcardHintEl.innerHTML = '选择通配规则后，可切到“完全随机 / 词库随机 / 自定义”三种子域模式。';
      if (wildcardCustomHintEl) {
        wildcardCustomHintEl.innerHTML = '输入 <code>inbox</code> 会自动拼成 <code>inbox.example.com</code>；也可直接输入完整域名。';
      }
      return;
    }
    const base = getWildcardBaseDomain(selectedRule);
    const localPart = addressInput?.value.trim() || '随机地址';
    if (selectedMode === 'wordlist') {
      wildcardHintEl.innerHTML = `会调用 <code>auto_subdomain=true</code> + <code>subdomain_mode=wordlist</code>，从后台可编辑的子域词库里随机选择标签，并创建类似 <code>${escHtml(localPart)}@support-center.${escHtml(base)}</code> 的地址。`;
    } else if (selectedMode === 'custom') {
      const preview = buildWildcardCustomDomain(selectedRule, wildcardCustomInput?.value || 'inbox');
      wildcardHintEl.innerHTML = `不会走自动分配，而是直接使用你指定的真实子域。`;
      if (wildcardCustomHintEl) {
        wildcardCustomHintEl.innerHTML = `当前将创建 <code>${escHtml(localPart)}@${escHtml(preview || `inbox.${base}`)}</code>。`;
      }
    } else {
      wildcardHintEl.innerHTML = `会调用 <code>auto_subdomain=true</code> 并完全随机生成真实子域，创建类似 <code>${escHtml(localPart)}@&lt;随机&gt;.${escHtml(base)}</code> 的地址。`;
      if (wildcardCustomHintEl) {
        wildcardCustomHintEl.innerHTML = '输入 <code>inbox</code> 会自动拼成 <code>inbox.example.com</code>；也可直接输入完整域名。';
      }
    }
  }

  wildcardModeSelect?.addEventListener('change', () => {
    refreshWildcardModeUi();
    refreshWildcardHint();
  });
  addressInput?.addEventListener('input', refreshWildcardHint);
  exactSelect?.addEventListener('change', () => {
    if (exactSelect.value && wildcardSelect) {
      wildcardSelect.value = '';
      refreshWildcardHint();
    }
  });
  customDomainInput?.addEventListener('input', () => {
    if (customDomainInput.value.trim() && wildcardSelect) {
      wildcardSelect.value = '';
      refreshWildcardHint();
    }
  });
  wildcardSelect?.addEventListener('change', () => {
    if (wildcardSelect.value) {
      if (exactSelect) exactSelect.value = '';
      if (customDomainInput) customDomainInput.value = '';
    }
    refreshWildcardHint();
  });
  wildcardCustomInput?.addEventListener('input', refreshWildcardHint);
  overlay.querySelectorAll('[data-fill-domain]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = overlay.querySelector('#mb-domain-custom');
      if (!target) return;
      target.value = btn.dataset.fillDomain || '';
      if (exactSelect) exactSelect.value = '';
      if (wildcardSelect) wildcardSelect.value = '';
      refreshWildcardHint();
      target.focus();
      target.setSelectionRange(0, target.value.length);
    });
  });
  refreshWildcardModeUi();
  refreshWildcardHint();

  overlay.querySelector('#mb-confirm-btn').addEventListener('click', async () => {
    const btn     = overlay.querySelector('#mb-confirm-btn');
    const address = overlay.querySelector('#mb-address').value.trim();
    const selectedDomain = exactSelect?.value || '';
    const selectedWildcardRule = wildcardSelect?.value || '';
    const selectedWildcardMode = wildcardModeSelect?.value || 'random';
    const wildcardCustomDomain = buildWildcardCustomDomain(selectedWildcardRule, wildcardCustomInput?.value || '');
    const customDomain = normalizeDomainInput(customDomainInput?.value || '');
    let domain  = customDomain || selectedWildcardRule || selectedDomain;
    let autoSubdomain = !customDomain && !!selectedWildcardRule && selectedWildcardMode !== 'custom';
    const permanent = overlay.querySelector('#mb-permanent')?.checked || false;
    btn.disabled  = true;
    btn.textContent = '创建中...';
    try {
      if (!customDomain && selectedWildcardRule && selectedWildcardMode === 'custom') {
        if (!wildcardCustomDomain) {
          throw new Error('请选择通配规则后，再填写自定义子域前缀或完整域名。');
        }
        domain = wildcardCustomDomain;
        autoSubdomain = false;
      }
      if (!domain && exactDomains.length === 0 && wildcardDomains.length > 0) {
        throw new Error('当前只有通配域名规则，请输入一个真实子域名，或直接在“自动生成子域”里选择一条 wildcard 规则。');
      }
      const body = {};
      if (address) body.address = address;
      if (domain)  body.domain  = domain;
      if (permanent) body.permanent = true;
      if (autoSubdomain) {
        body.auto_subdomain = true;
        body.subdomain_mode = selectedWildcardMode === 'wordlist' ? 'wordlist' : 'random';
      }
      const resp = await api.createMailbox(body);
      const mb = resp.mailbox || resp;
      overlay.remove();
      if (resp.auto_subdomain && resp.subdomain_mode === 'wordlist') {
        toast(`已按词库分配：${mb.full_address}`, 'success');
      } else if (resp.auto_subdomain) {
        toast(`已自动分配：${mb.full_address}`, 'success');
      } else if (resp.claimed) {
        toast(`已认领：${mb.full_address}`, 'success');
      } else if (resp.message === 'mailbox already exists') {
        toast(`已存在：${mb.full_address}`, 'success');
      } else {
        toast(`已创建：${mb.full_address}`, 'success');
      }
      navigate('dashboard');
    } catch(e) {
      btn.disabled = false;
      btn.textContent = '创建';
      toast('创建失败：' + e.message, 'error');
    }
  });
};

window.confirmDeleteMailbox = function(id, addr) {
  showModal(`删除邮箱`, `<p>确定删除 <strong>${escHtml(addr)}</strong>？<br/><span style="font-size:0.8rem;color:var(--clr-danger)">所有邮件将被永久删除。</span></p>`,
    async () => {
      try {
        await api.deleteMailbox(id);
        toast('邮箱已删除', 'success');
        navigate('dashboard');
      } catch(e) { toast('删除失败: ' + e.message, 'error'); }
    }
  );
};

// ─── API Key 展示 ──────────────────────────────────────────
function renderApiKeyShow(container) {
  const key = state.apiKey || '—';
  container.innerHTML = `
    <div class="card" style="max-width:540px">
      <div class="card-header"><div class="card-title">⚿ 我的 API Key</div></div>
      <div class="card-body">
        <p style="font-size:0.84rem;color:var(--text-secondary);margin-bottom:1rem">
          API Key 用于认证所有 API 请求。请勿泄露。
        </p>
        <div class="form-label">当前 API Key</div>
        <div class="code-box" style="margin-bottom:1rem">
          <span style="filter:blur(4px);cursor:pointer" id="key-blur" onclick="this.style.filter='none'">${escHtml(key)}</span>
          <button class="copy-btn" onclick="copyText('${escHtml(key)}')" title="复制">⎘</button>
        </div>
        <p style="font-size:0.76rem;color:var(--text-muted)">点击 Key 可显示明文。保存后请妥善保管，丢失需联系管理员重置。</p>
        <div class="divider"></div>
        <div class="form-label">HTTP 请求示例</div>
        <div class="code-box" style="font-size:0.75rem">curl -H "Authorization: Bearer &lt;api_key&gt;" http://server:8080/api/mailboxes</div>
      </div>
    </div>
  `;
}

// ─── Inbox ────────────────────────────────────────────────
function getInboxBulkKey(mb = state.currentMailbox) {
  if (!mb?.id) return 'inbox-emails';
  return `inbox-emails-${mb.scope || 'regular'}-${mb.id}`;
}

async function renderInbox(container) {
  const mb = state.currentMailbox;
  if (!mb) { navigate('dashboard'); return; }
  const bulkKey = getInboxBulkKey(mb);
  const listKey = getInboxListViewKey(mb);
  const backPage = getMailboxBackPage(mb);
  const pagerState = getListViewState(listKey, { page: 1, size: INBOX_EMAIL_PAGE_SIZE, q: '' });
  const query = String(pagerState.q || '').trim();

  const title = $('topbar-title'); if (title) title.textContent = mb.full_address;
  const sub   = $('topbar-subtitle'); if (sub) sub.textContent = isAdminCatchallScope(mb) ? 'Catch-all 邮件列表' : '邮件列表';
  const actions = $('topbar-actions');
  if (actions) {
    actions.innerHTML = `
      <button class="btn btn-ghost btn-sm" onclick="copyText('${escHtml(mb.full_address)}')">⎘ 复制地址</button>
      <button class="btn btn-primary btn-sm" onclick="refreshInbox()" style="margin-left:0.4rem">↻ 刷新</button>
      <button class="btn btn-ghost btn-sm" onclick="navigate('${backPage}')" style="margin-left:0.4rem">← 返回</button>
    `;
  }

  const emailPage = await listEmailsPageForMailbox(mb, pagerState.page, pagerState.size, query);
  if (pagerState.page > emailPage.totalPages) {
    updateListViewState(listKey, { page: emailPage.totalPages }, { page: 1, size: INBOX_EMAIL_PAGE_SIZE, q: '' });
    return renderInbox(container);
  }
  updateListViewState(listKey, { page: emailPage.page, size: emailPage.size, q: query }, { page: 1, size: INBOX_EMAIL_PAGE_SIZE, q: '' });
  state.emails = emailPage.data || [];
  state.currentEmailPage = emailPage;
  setBulkVisibleIds(bulkKey, state.emails.map(e => e.id));

  // 启动自动刷新（每 8 秒）
  clearInboxPoller();
  _inboxPollerTimer = setInterval(async () => {
    if (state.page !== 'inbox') { clearInboxPoller(); return; }
    if (document.hidden) return;
    try {
      const currentPager = getListViewState(listKey, { page: 1, size: INBOX_EMAIL_PAGE_SIZE, q: '' });
      const freshPage = await listEmailsPageForMailbox(mb, currentPager.page, currentPager.size, String(currentPager.q || '').trim());
      if (!freshPage) return;
      const fresh = freshPage.data || [];
      // 有新邮件才重新渲染，避免闪烁
      if (freshPage.total !== state.currentEmailPage?.total ||
          fresh.length !== (state.emails || []).length ||
          fresh[0]?.id !== state.emails?.[0]?.id ||
          fresh[fresh.length - 1]?.id !== state.emails?.[state.emails.length - 1]?.id) {
        state.emails = fresh;
        state.currentEmailPage = freshPage;
        const c = $('page-content');
        if (c) renderInbox(c);
      }
    } catch(e) { /* 静默失败 */ }
  }, 8000);

  if (!state.emails.length) {
    container.innerHTML = `
      ${buildListFilterBar({
        key: listKey,
        searchValue: query,
        searchPlaceholder: '搜索发件人、主题或正文片段',
        searchButtonLabel: '搜索邮件',
        hint: '可按发件人、主题或正文内容搜索当前邮箱中的邮件。',
      })}
      <div class="card">
        <div class="empty-state">
          <span class="empty-icon">📭</span>
          <p>${query ? '没有匹配当前搜索条件的邮件' : '暂无邮件'}</p>
          <p style="margin-top:0.5rem;font-size:0.8rem">${query ? `请尝试更换关键词，或清空筛选后重新查看 <strong>${escHtml(mb.full_address)}</strong>。` : `向 <strong>${escHtml(mb.full_address)}</strong> 发送邮件后，邮件将显示在此处`}</p>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    ${buildListFilterBar({
      key: listKey,
      searchValue: query,
      searchPlaceholder: '搜索发件人、主题或正文片段',
      searchButtonLabel: '搜索邮件',
      hint: '可按发件人、主题或正文内容搜索当前邮箱中的邮件。',
    })}
    ${buildBulkToolbar({
      key: bulkKey,
      itemLabel: '邮件',
      actions: [
        { value: 'delete', label: '删除选中邮件', run: () => window.bulkDeleteEmails(bulkKey) },
      ],
      scopeHint: '当前批量操作仅对本页邮件生效，翻页后会自动切换到新页面的可见列表。',
    })}
    <div class="card" style="padding:0">
      ${state.emails.map(e => buildEmailItem(mb.id, e, bulkKey)).join('')}
      ${buildPaginationBar({
        page: emailPage.page,
        size: emailPage.size,
        total: emailPage.total,
        totalPages: emailPage.totalPages,
        itemLabel: '邮件',
        pageSizeOptions: INBOX_EMAIL_PAGE_SIZE_OPTIONS,
        onPageChange: 'setListPage',
        onPageSizeChange: 'setListPageSize',
        pagerKey: listKey,
        compact: true,
        hideIfSinglePage: true,
      })}
    </div>
  `;
}

function buildEmailItem(mbId, e, bulkKey = getInboxBulkKey()) {
  const from = e.sender || e.from_addr || '(无发件人)';
  const initials = from.charAt(0).toUpperCase();
  const preview = (e.body_text || e.text_body || '').slice(0, 80).replace(/\n/g, ' ');
  return `
    <div class="email-item" onclick="openEmail('${mbId}','${e.id}')">
      <div class="email-avatar">${escHtml(initials)}</div>
      <div class="email-meta">
        <div class="email-from">${escHtml(from)}</div>
        <div class="email-subject">${escHtml(e.subject || '(无主题)')}</div>
        <div class="email-preview">${escHtml(preview)}</div>
      </div>
      <div>
        <label style="display:flex;justify-content:flex-end;cursor:pointer" onclick="event.stopPropagation()">
          <input type="checkbox" data-bulk-key="${bulkKey}" data-bulk-id="${e.id}" ${isBulkSelected(bulkKey, e.id) ? 'checked' : ''} onchange="toggleBulkSelection('${bulkKey}','${e.id}', this.checked)">
        </label>
        <div class="email-time">${timeAgo(e.received_at)}</div>
        <button class="btn btn-ghost btn-sm" style="margin-top:0.3rem" onclick="event.stopPropagation();deleteEmail('${mbId}','${e.id}')">✕</button>
      </div>
    </div>
  `;
}

window.openEmail = function(mbId, eid) {
  state.currentMailbox = state.currentMailbox || { id: mbId };
  state.currentEmailId = eid;
  navigate('email-view');
};

window.refreshInbox = function() {
  clearInboxPoller();
  renderPage('inbox');
};

window.deleteEmail = async function(mbId, eid) {
  try {
    const mb = state.currentMailbox && state.currentMailbox.id === mbId
      ? state.currentMailbox
      : { id: mbId, scope: 'regular' };
    await deleteEmailForMailbox(eid, mb);
    toast('邮件已删除', 'success');
    navigate('inbox');
  } catch(e) { toast('删除失败: ' + e.message, 'error'); }
};

window.bulkDeleteEmails = async function(selectionKey = getInboxBulkKey()) {
  const mailbox = state.currentMailbox;
  await runBulkDelete({
    selectionKey,
    itemLabel: '邮件',
    onDelete: id => deleteEmailForMailbox(id, mailbox),
    onDone: async () => navigate('inbox'),
  });
};

// ─── Email View ────────────────────────────────────────────
async function renderEmailView(container) {
  const mb = state.currentMailbox;
  const eid = state.currentEmailId;
  if (!mb || !eid) { navigate(getMailboxBackPage(mb)); return; }

  const actions = $('topbar-actions');
  if (actions) {
    actions.innerHTML = `
      <button class="btn btn-ghost btn-sm" onclick="navigate('inbox')">← 返回列表</button>
      <button class="btn btn-danger btn-sm" onclick="deleteEmail('${mb.id}','${eid}');navigate('inbox')" style="margin-left:0.4rem">删除</button>
    `;
  }

  const e = await getEmailForMailbox(eid, mb);
  const fromAddr = e.sender || e.from_addr || '—';
  const toAddr   = mb.full_address || state.currentMailbox?.full_address || '—';
  const htmlBody  = e.body_html || e.html_body || '';
  const textBody  = e.body_text || e.text_body || '';
  const title = $('topbar-title'); if (title) title.textContent = e.subject || '(无主题)';
  const sub   = $('topbar-subtitle'); if (sub) sub.textContent = `来自：${fromAddr}`;

  // 先渲染完整 HTML（含 iframe 占位），再向 iframe 写入内容
  container.innerHTML = `
    <div class="card" style="padding:0;max-width:980px">
      <div class="email-detail-header">
        <div class="email-subject-big">${escHtml(e.subject || '(无主题)')}</div>
        <div class="email-info-row">
          <span>发件人：<strong>${escHtml(fromAddr)}</strong></span>
          <span style="margin:0 0.3rem">·</span>
          <span>收件人：<strong>${escHtml(toAddr)}</strong></span>
          <span style="margin:0 0.3rem">·</span>
          <span>${formatDate(e.received_at)}</span>
        </div>
      </div>
      ${htmlBody
        ? `<iframe class="email-body-frame" id="email-frame" sandbox="allow-same-origin allow-popups"></iframe>`
        : `<div class="email-body-text" style="white-space:pre-wrap">${escHtml(textBody || '(邮件内容为空)')}</div>`
      }
    </div>
  `;

  // innerHTML 中的 <script> 不会执行；在 DOM 就绪后直接向 iframe 写内容
  if (htmlBody) {
    const frame = container.querySelector('#email-frame');
    if (frame) {
      frame.contentDocument.open();
      frame.contentDocument.write(htmlBody);
      frame.contentDocument.close();
      const setH = () => {
        try { frame.style.height = frame.contentDocument.body.scrollHeight + 20 + 'px'; } catch (_) {}
      };
      frame.addEventListener('load', setH);
      setTimeout(setH, 300);
    }
  }
}

// ─── 域名列表 & 指南 ─────────────────────────────────────────
async function renderDomainsGuide(container) {
  const controlsKey = 'domains-guide-controls';
  const actions = $('topbar-actions');
  if (actions) {
    actions.innerHTML = `<button class="btn btn-success btn-sm" onclick="showMXRegisterModal()">⚡ 提交域名自动验证</button>`;
  }
  clearPendingDomainPoller();

  const [domains, pub] = await Promise.all([
    api.domains(),
    api.publicSettings().catch(() => ({})),
  ]);
  const smtpIP  = pub.smtp_server_ip || '';
  const smtpHostname = pub.smtp_hostname || '';
  const ipLabel = smtpIP || '&lt;服务器 IP&gt;';
  const mxTarget = smtpHostname || '&lt;服务器邮件主机名&gt;';
  const needsARec = !smtpHostname;
  const controlState = getListViewState(controlsKey, { page: 1, size: DOMAIN_PAGE_SIZE, q: '' });
  const query = String(controlState.q || '').trim();
  const normalizedQuery = query.toLowerCase();
  const matchDomain = (domain) => !normalizedQuery || String(domain?.domain || '').toLowerCase().includes(normalizedQuery);

  const filteredDomains = (domains || []).filter(matchDomain);
  const pending = filteredDomains.filter(d => d.status === 'pending');
  const active  = filteredDomains.filter(d => d.status !== 'pending');
  const activeGroups = splitManagedDomains(active);
  const pendingGroups = splitManagedDomains(pending);
  const pendingPage = getLocalPageData('domains-guide-pending', pending, DOMAIN_PAGE_SIZE);
  const exactPage = getLocalPageData('domains-guide-exact', activeGroups.exact, DOMAIN_PAGE_SIZE);
  const wildcardPage = getLocalPageData('domains-guide-wildcard', activeGroups.wildcard, DOMAIN_PAGE_SIZE);

  const summaryCardsHtml = `
    <div class="stat-grid domain-overview-grid">
      <div class="stat-card">
        <div class="stat-label">精确域名</div>
        <div class="stat-value">${activeGroups.exact.length}</div>
        <div class="stat-note">可直接作为 @domain 使用</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">通配规则</div>
        <div class="stat-value">${activeGroups.wildcard.length}</div>
        <div class="stat-note">覆盖任意子域，不含根域</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">待验证</div>
        <div class="stat-value">${pending.length}</div>
        <div class="stat-note">${pending.length > 0 ? `精确 ${pendingGroups.exact.length} / 通配 ${pendingGroups.wildcard.length}` : '当前无待验证项'}</div>
      </div>
    </div>
  `;

  const pendingHtml = pending.length > 0 ? `
    <div class="card" style="border-left:3px solid var(--clr-warn,#e6a817)">
      <div class="card-header">
        <div class="card-title">🔄 待 MX 验证 (${pending.length})</div>
        <div style="font-size:0.78rem;color:var(--text-muted)">后台每 30 秒自动检测，验证通过后自动激活${pendingPage.totalPages > 1 ? ` · 第 ${pendingPage.page}/${pendingPage.totalPages} 页` : ''}</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>域名</th><th>类型</th><th>上次检测</th><th>状态</th></tr></thead>
          <tbody>
            ${pendingPage.data.map(d => `
              <tr id="pending-row-${d.id}">
                <td style="font-family:var(--font-mono);font-size:0.82rem">${escHtml(d.domain)}</td>
                <td>${renderDomainTypeHtml(d.domain)}</td>
                <td style="font-size:0.78rem">${d.mx_checked_at ? timeAgo(d.mx_checked_at) : '待首次检测'}</td>
                <td><span class="badge badge-gold" id="pending-status-${d.id}">⏳ 检测中</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${buildPaginationBar({
        page: pendingPage.page,
        size: pendingPage.size,
        total: pendingPage.total,
        totalPages: pendingPage.totalPages,
        itemLabel: '待验证域名',
        pageSizeOptions: DOMAIN_PAGE_SIZE_OPTIONS,
        onPageChange: 'setListPage',
        onPageSizeChange: 'setListPageSize',
        pagerKey: 'domains-guide-pending',
        compact: true,
        hideIfSinglePage: true,
      })}
    </div>
  ` : '';

  const exactDomainsHtml = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">◎ 精确域名</div>
        <div style="font-size:0.78rem;color:var(--text-muted)">共 ${activeGroups.exact.length} 个${exactPage.totalPages > 1 ? ` · 第 ${exactPage.page}/${exactPage.totalPages} 页` : ''}</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>域名</th><th>说明</th><th>状态</th></tr></thead>
          <tbody>
            ${activeGroups.exact.length === 0
              ? `<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">暂无精确域名</td></tr>`
              : exactPage.data.map(d => `
                <tr>
                  <td style="font-family:var(--font-mono);font-size:0.82rem" title="${escHtml(d.domain)}">${escHtml(d.domain)}</td>
                  <td>
                    <div class="domain-example-stack">
                      <code title="${escHtml(d.domain)}">${escHtml(d.domain)}</code>
                      <div class="domain-example-note" title="可直接创建如 hello@${escHtml(d.domain)}">可直接创建如 hello@${escHtml(d.domain)}</div>
                    </div>
                  </td>
                  <td>${d.is_active
                    ? '<span class="badge badge-green">● 启用</span>'
                    : '<span class="badge badge-gray">○ 停用</span>'}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
      ${buildPaginationBar({
        page: exactPage.page,
        size: exactPage.size,
        total: exactPage.total,
        totalPages: exactPage.totalPages,
        itemLabel: '精确域名',
        pageSizeOptions: DOMAIN_PAGE_SIZE_OPTIONS,
        onPageChange: 'setListPage',
        onPageSizeChange: 'setListPageSize',
        pagerKey: 'domains-guide-exact',
        compact: true,
        hideIfSinglePage: true,
      })}
    </div>
  `;

  const wildcardDomainsHtml = `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">✳ 通配子域规则</div>
          <div class="domain-section-hint">匹配任意子域，例如 <code>team.example.com</code>，但不会匹配根域 <code>example.com</code></div>
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted)">共 ${activeGroups.wildcard.length} 个${wildcardPage.totalPages > 1 ? ` · 第 ${wildcardPage.page}/${wildcardPage.totalPages} 页` : ''}</div>
      </div>
      <div class="table-wrap">
        <table class="wildcard-domain-table">
          <thead><tr><th>规则</th><th>匹配示例</th><th>状态</th></tr></thead>
          <tbody>
            ${activeGroups.wildcard.length === 0
              ? `<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">暂无通配规则</td></tr>`
              : wildcardPage.data.map(d => `
                <tr>
                  <td class="domain-rule-cell">
                    <div class="domain-rule-code" title="${escHtml(d.domain)}">${escHtml(d.domain)}</div>
                    <div style="margin-top:0.3rem">${renderDomainTypeHtml(d.domain)}</div>
                  </td>
                  <td class="domain-example-cell">${renderWildcardExamplesHtml(d.domain)}</td>
                  <td>${d.is_active
                    ? '<span class="badge badge-green">● 启用</span>'
                    : '<span class="badge badge-gray">○ 停用</span>'}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
      ${buildPaginationBar({
        page: wildcardPage.page,
        size: wildcardPage.size,
        total: wildcardPage.total,
        totalPages: wildcardPage.totalPages,
        itemLabel: '通配规则',
        pageSizeOptions: DOMAIN_PAGE_SIZE_OPTIONS,
        onPageChange: 'setListPage',
        onPageSizeChange: 'setListPageSize',
        pagerKey: 'domains-guide-wildcard',
        compact: true,
        hideIfSinglePage: true,
      })}
    </div>
  `;

  container.innerHTML = `
    <div class="page-stack page-stack-guide">
      ${summaryCardsHtml}
      ${buildListFilterBar({
        key: controlsKey,
        searchValue: query,
        searchPlaceholder: '搜索域名或通配规则，例如 example.com',
        searchButtonLabel: '搜索域名',
        hint: '支持按精确域名或通配规则关键词筛选当前列表。',
      })}
      ${pendingHtml}
      <div class="domain-sections-grid">
        ${exactDomainsHtml}
        ${wildcardDomainsHtml}
        <div class="card domain-guide-card">
          <div class="card-header"><div class="card-title">📖 添加域名指南</div></div>
          <div class="card-body">
            <div class="guide-step">
              <div class="step-num">1</div>
              <div class="step-body">
                <div class="step-title">准备域名</div>
                <div class="step-desc">在域名注册商处购买一个域名，例如 <code>example.com</code>，并获取 DNS 管理权限。</div>
              </div>
            </div>
            <div class="guide-step">
              <div class="step-num">2</div>
              <div class="step-body">
                <div class="step-title">配置 MX 记录（仅需一条）</div>
                <div class="step-desc">在 DNS 面板添加以下记录，让 SMTP 邮件投递到本服务器：</div>
                <table class="dns-table" style="margin-top:0.5rem">
                  <thead><tr><th>类型</th><th>主机名</th><th>内容</th><th>优先级</th></tr></thead>
                  <tbody>
                    <tr><td>MX</td><td>@</td><td style="font-family:monospace">${mxTarget}</td><td>10</td></tr>
                    ${needsARec ? `<tr><td>A</td><td style="font-family:monospace">mail.yourdomain.com</td><td style="font-family:monospace">${ipLabel}</td><td>—</td></tr>` : ''}
                    <tr><td>TXT</td><td>@</td><td style="font-family:monospace">v=spf1 ip4:${ipLabel} ~all</td><td>—</td></tr>
                  </tbody>
                </table>
                <div class="step-desc" style="margin-top:0.6rem">
                  如果你想接收任意子域（例如 <code>user@a.example.com</code>、<code>user@b.c.example.com</code>），可以提交 <code>*.example.com</code> 作为通配规则。此时把 MX/TXT 记录的主机名改为 <code>*</code>；注意这<strong>不包含根域</strong> <code>example.com</code>，若根域也要收信，请再单独添加一次精确域名。
                </div>
              </div>
            </div>
            <div class="guide-step">
              <div class="step-num">3</div>
              <div class="step-body">
                <div class="step-title">提交域名自动验证</div>
                <div class="step-desc">
                  DNS 广播后（通常 5–30 分钟），点击右上角「⚡ 提交域名自动验证」按钮。<br>
                  <ul style="margin:0.4rem 0 0 1rem;font-size:0.82rem">
                    <li>MX 已生效 → <b>立即激活</b>加入域名池</li>
                    <li>MX 未生效 → 进入<b>待验证队列</b>，后台每 30 秒自动重试</li>
                  </ul>
                </div>
                <button class="btn btn-success btn-sm" style="margin-top:0.5rem" onclick="showMXRegisterModal()">⚡ 提交域名</button>
              </div>
            </div>
            <div class="guide-step">
              <div class="step-num">4</div>
              <div class="step-body">
                <div class="step-title">验证收信</div>
                <div class="step-desc">域名激活后，创建该域名下的邮箱，用其他邮件客户端发送测试邮件，30 秒内应能收到。若使用通配规则，可直接创建实际子域（例如 <code>demo.example.com</code>）下的邮箱地址。</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  if (pending.length > 0) {
    startPendingDomainPoller(pending.map(d => d.id));
  }
}

// ─── Admin: 账户管理 ─────────────────────────────────────────
async function renderAdminAccounts(container) {
  const bulkKey = 'admin-accounts';
  const listKey = 'admin-accounts-list';
  const actions = $('topbar-actions');
  if (actions) {
    actions.innerHTML = `<button class="btn btn-primary btn-sm" onclick="showCreateAccountModal()">+ 创建账户</button>`;
  }

  const pagerState = getListViewState(listKey, { page: 1, size: ADMIN_ACCOUNT_PAGE_SIZE, q: '', role: 'all' });
  const query = String(pagerState.q || '').trim();
  const role = ['all', 'admin', 'user', 'system'].includes(String(pagerState.role || 'all'))
    ? String(pagerState.role || 'all')
    : 'all';
  const accountPage = await api.admin.listAccountsPage(pagerState.page, pagerState.size, query, role);
  if (pagerState.page > accountPage.totalPages) {
    updateListViewState(listKey, { page: accountPage.totalPages }, { page: 1, size: ADMIN_ACCOUNT_PAGE_SIZE, q: '', role: 'all' });
    return renderAdminAccounts(container);
  }
  updateListViewState(listKey, { page: accountPage.page, size: accountPage.size, q: query, role }, { page: 1, size: ADMIN_ACCOUNT_PAGE_SIZE, q: '', role: 'all' });

  const accounts = accountPage.data || [];
  const deletableAccountIds = accounts
    .filter(a => !a.is_system && !a.is_admin)
    .map(a => a.id);
  setBulkVisibleIds(bulkKey, deletableAccountIds);
  container.innerHTML = `
    <div style="max-width:1240px;display:flex;flex-direction:column;gap:1rem">
      ${buildListFilterBar({
        key: listKey,
        searchValue: query,
        searchPlaceholder: '搜索用户名或 API Key',
        searchButtonLabel: '搜索账户',
        filters: [
          {
            field: 'role',
            label: '角色',
            value: role,
            options: [
              { value: 'all', label: '全部角色' },
              { value: 'admin', label: '管理员' },
              { value: 'user', label: '普通用户' },
              { value: 'system', label: '系统账号' },
            ],
          },
        ],
        hint: '可按用户名、API Key 或角色筛选账户列表。',
      })}
      ${deletableAccountIds.length > 0 ? buildBulkToolbar({
        key: bulkKey,
        itemLabel: '可删除账户',
        actions: [
          { value: 'delete', label: '删除选中账户', run: () => window.bulkDeleteAccounts(bulkKey) },
        ],
        scopeHint: '当前批量操作仅对本页账户生效，翻页后会自动切换到新页面的可见列表。',
      }) : ''}
      <div class="card">
        <div class="card-header">
          <div class="card-title">👥 账户列表</div>
          <div style="font-size:0.78rem;color:var(--text-muted)">共 ${accountPage.total} 个账户${accountPage.totalPages > 1 ? ` · 第 ${accountPage.page}/${accountPage.totalPages} 页` : ''}</div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th style="width:44px">选择</th><th>用户名</th><th>角色</th><th>永久邮箱额度</th><th>创建时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              ${accounts.length === 0 ? `
                <tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:1.2rem">没有匹配当前筛选条件的账户</td></tr>
              ` : accounts.map(a => `
                <tr>
                  <td style="text-align:center">
                    ${(!a.is_system && !a.is_admin)
                      ? `<input type="checkbox" data-bulk-key="${bulkKey}" data-bulk-id="${a.id}" ${isBulkSelected(bulkKey, a.id) ? 'checked' : ''} onchange="toggleBulkSelection('${bulkKey}','${a.id}', this.checked)">`
                      : '<span style="font-size:0.75rem;color:var(--text-muted)">—</span>'}
                  </td>
                  <td>
                    <div style="font-weight:600">${escHtml(a.username || '—')}</div>
                    ${a.is_system
                      ? `<div style="margin-top:0.35rem;font-size:0.74rem;color:var(--text-muted)">系统保留账号，内部用于 catch-all 暂存</div>`
                      : `
                        <div class="code-box" style="margin-top:0.3rem;font-size:0.72rem">
                          <span>${escHtml(a.api_key || '—')}</span>
                          <button class="copy-btn" onclick="copyText('${escHtml(a.api_key||'')}')">⎘</button>
                        </div>
                      `}
                  </td>
                  <td>
                    ${a.is_system
                      ? '<span class="badge badge-gray">系统账号</span>'
                      : (a.is_admin
                        ? '<span class="badge badge-gold">管理员</span>'
                        : '<span class="badge badge-gray">普通用户</span>')}
                    ${a.id === state.account?.id ? '<div style="margin-top:0.35rem;font-size:0.74rem;color:var(--text-muted)">当前登录账号</div>' : ''}
                  </td>
                  <td>
                    ${a.is_system
                      ? '<span style="font-size:0.76rem;color:var(--text-muted)">—</span>'
                      : (a.is_admin
                        ? '<div style="font-weight:600">∞</div><div style="margin-top:0.35rem;font-size:0.74rem;color:var(--text-muted)">管理员无限制</div>'
                        : `<div style="font-weight:600">${Number(a.permanent_mailbox_quota || 0)} 个</div><div style="margin-top:0.35rem;font-size:0.74rem;color:var(--text-muted)">可由管理员追加</div>`)}
                  </td>
                  <td style="font-size:0.8rem">${formatDate(a.created_at)}</td>
                  <td>
                    ${a.is_system ? '<span style="font-size:0.76rem;color:var(--text-muted)">系统保留</span>' : `
                      <div style="display:flex;gap:0.4rem;flex-wrap:wrap">
                        ${!a.is_admin ? `<button class="btn btn-ghost btn-sm" onclick="showSetAccountQuotaModal('${a.id}', '${escHtml(a.username||'')}', ${Number(a.permanent_mailbox_quota || 0)})">永久额度</button>` : ''}
                        ${a.is_admin
                          ? `<button class="btn btn-ghost btn-sm" onclick="toggleAccountAdmin('${a.id}', false, '${escHtml(a.username||'')}')">解除管理员</button>`
                          : `<button class="btn btn-success btn-sm" onclick="toggleAccountAdmin('${a.id}', true, '${escHtml(a.username||'')}')">设为管理员</button>`}
                        ${!a.is_admin ? `<button class="btn btn-danger btn-sm" onclick="confirmDeleteAccount('${a.id}','${escHtml(a.username||'')}')">删除</button>` : ''}
                      </div>
                    `}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${buildPaginationBar({
          page: accountPage.page,
          size: accountPage.size,
          total: accountPage.total,
          totalPages: accountPage.totalPages,
          itemLabel: '账户',
          pageSizeOptions: ADMIN_ACCOUNT_PAGE_SIZE_OPTIONS,
          onPageChange: 'setListPage',
          onPageSizeChange: 'setListPageSize',
          pagerKey: listKey,
          compact: true,
          hideIfSinglePage: true,
        })}
      </div>
    </div>
  `;
}

window.showCreateAccountModal = function() {
  showModal('创建账户', `
    <div class="form-group">
      <label class="form-label">用户名</label>
      <input class="form-input" id="new-acc-username" placeholder="username" />
    </div>
    <div class="form-group">
      <label class="form-label">
        <input type="checkbox" id="new-acc-admin" style="margin-right:0.4rem">
        设为管理员
      </label>
    </div>
  `, async () => {
    const username = ($('new-acc-username')?.value || '').trim();
    if (!username) { toast('请输入用户名', 'warn'); return false; }
    const is_admin = $('new-acc-admin')?.checked || false;
    try {
      await api.admin.createAccount({ username, is_admin });
      toast('账户已创建', 'success');
      navigate('admin-accounts');
    } catch(e) { toast('创建失败: ' + e.message, 'error'); return false; }
  });
};

window.confirmDeleteAccount = function(id, name) {
  showModal('删除账户', `<p>确定删除账户 <strong>${escHtml(name)}</strong>？</p>`, async () => {
    try {
      await api.admin.deleteAccount(id);
      toast('账户已删除', 'success');
      navigate('admin-accounts');
    } catch(e) { toast('删除失败: ' + e.message, 'error'); }
  });
};

window.showSetAccountQuotaModal = function(id, name, currentQuota) {
  showModal('调整永久邮箱额度', `
    <div class="form-group">
      <label class="form-label">账户</label>
      <div class="code-box" style="font-size:0.82rem">${escHtml(name)}</div>
    </div>
    <div class="form-group">
      <label class="form-label">永久邮箱额度</label>
      <input class="form-input" id="account-permanent-quota" type="number" min="0" max="100000" value="${Number(currentQuota || 0)}" />
      <div class="form-hint">仅普通用户受此额度限制；管理员始终为无限制。</div>
    </div>
  `, async () => {
    const quota = Number(($('account-permanent-quota')?.value || '').trim());
    if (!Number.isInteger(quota) || quota < 0 || quota > 100000) {
      toast('请输入 0 - 100000 之间的整数', 'warn');
      return false;
    }
    try {
      const resp = await api.admin.setAccountQuota(id, quota);
      const updated = resp.account || {};
      if (updated.id && updated.id === state.account?.id) {
        state.account = {
          ...(state.account || {}),
          permanent_mailbox_quota: updated.permanent_mailbox_quota,
        };
        localStorage.setItem('tm_account', JSON.stringify(state.account));
      }
      toast('永久邮箱额度已更新', 'success');
      navigate('admin-accounts');
    } catch (e) {
      toast('更新失败: ' + e.message, 'error');
      return false;
    }
  });
};

window.toggleAccountAdmin = function(id, isAdmin, name) {
  const actionText = isAdmin ? '设为管理员' : '解除管理员';
  showModal(actionText, `<p>确定将账户 <strong>${escHtml(name)}</strong> ${actionText}？</p>`, async () => {
    try {
      const resp = await api.admin.toggleAccountAdmin(id, isAdmin);
      const updated = resp.account || {};
      if (updated.id && updated.id === state.account?.id) {
        state.account = { ...(state.account || {}), is_admin: !!updated.is_admin };
        localStorage.setItem('tm_account', JSON.stringify(state.account));
      }
      toast(`已${actionText}`, 'success');
      if (updated.id && updated.id === state.account?.id && !updated.is_admin) {
        navigate('dashboard');
      } else {
        navigate('admin-accounts');
      }
    } catch(e) {
      toast(`${actionText}失败: ` + e.message, 'error');
      return false;
    }
  });
};

// ─── Admin: Catch-all 收件箱 ─────────────────────────────────
async function renderAdminCatchall(container) {
  const bulkKey = 'admin-catchall';
  const listKey = 'admin-catchall-mailboxes';
  const actions = $('topbar-actions');
  if (actions) {
    actions.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="navigate('admin-settings')">⚙ 调整 Catch-all 设置</button>`;
  }

  const pagerState = getListViewState(listKey, { page: 1, size: CATCHALL_MAILBOX_PAGE_SIZE, q: '', owner: 'all' });
  const query = String(pagerState.q || '').trim();
  const owner = ['all', 'admin', 'user', 'system'].includes(String(pagerState.owner || 'all'))
    ? String(pagerState.owner || 'all')
    : 'all';
  const [mailboxPage, settings, accounts] = await Promise.all([
    api.admin.listCatchallMailboxesPage(pagerState.page, pagerState.size, query, owner).catch(() => normalizePaginatedResponse([], pagerState.page, pagerState.size)),
    api.admin.getSettings().catch(() => ({})),
    api.admin.listAllAccounts().catch(() => []),
  ]);
  if (pagerState.page > mailboxPage.totalPages) {
    updateListViewState(listKey, { page: mailboxPage.totalPages }, { page: 1, size: CATCHALL_MAILBOX_PAGE_SIZE, q: '', owner: 'all' });
    return renderAdminCatchall(container);
  }
  updateListViewState(listKey, { page: mailboxPage.page, size: mailboxPage.size, q: query, owner }, { page: 1, size: CATCHALL_MAILBOX_PAGE_SIZE, q: '', owner: 'all' });
  const mailboxes = mailboxPage.data || [];

  const policy = settings.unknown_recipient_policy || 'claimable';
  const configuredAdminId = settings.catchall_admin_account_id || '';
  const configuredAdmin = (accounts || []).find(a => a.id === configuredAdminId);
  const activeAdmins = (accounts || []).filter(a => a.is_admin && a.is_active && !a.is_system);
  const fallbackAdmin = activeAdmins.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
  const policyText = policy === 'admin_only'
    ? '管理员专属模式：未知地址邮件会交给管理员 catch-all'
    : '弱所有权模式：未知地址邮件先进入系统 catch-all，可被后续认领';
  const ownerText = policy === 'admin_only'
    ? (configuredAdmin
      ? `当前指定接收管理员：${configuredAdmin.username}`
      : (fallbackAdmin ? `当前自动接收管理员：${fallbackAdmin.username}` : '当前无可用管理员'))
    : '当前接收者：系统账号 _catchall';
  setBulkVisibleIds(bulkKey, (mailboxes || []).map(mb => mb.id));

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:1rem;max-width:1260px">
      ${buildListFilterBar({
        key: listKey,
        searchValue: query,
        searchPlaceholder: '搜索地址或归属用户名',
        searchButtonLabel: '搜索 Catch-all',
        filters: [
          {
            field: 'owner',
            label: '归属',
            value: owner,
            options: [
              { value: 'all', label: '全部归属' },
              { value: 'admin', label: '管理员' },
              { value: 'user', label: '普通用户' },
              { value: 'system', label: '系统账号' },
            ],
          },
        ],
        hint: '支持按 Catch-all 地址、归属用户名和归属类型筛选。',
      })}
      <div class="card">
        <div class="card-header">
          <div class="card-title">📥 Catch-all 收件箱概览</div>
          <div style="font-size:0.78rem;color:var(--text-muted)">当前共 ${mailboxPage.total} 个 catch-all 地址${mailboxPage.totalPages > 1 ? ` · 第 ${mailboxPage.page}/${mailboxPage.totalPages} 页` : ''}</div>
        </div>
        <div class="card-body" style="font-size:0.84rem;color:var(--text-secondary);line-height:1.8">
          <div><strong>模式：</strong>${escHtml(policyText)}</div>
          <div><strong>接收归属：</strong>${escHtml(ownerText)}</div>
        </div>
      </div>

      ${!mailboxes.length ? `
        <div class="card">
          <div class="empty-state">
            <span class="empty-icon">📭</span>
            <p>${query || owner !== 'all' ? '没有匹配当前筛选条件的 Catch-all 邮箱' : '当前没有 catch-all 邮箱'}</p>
            <p style="margin-top:0.5rem;font-size:0.8rem">${query || owner !== 'all' ? '请调整搜索词或归属筛选后重试。' : '当未知地址收到邮件时，这里会自动出现对应地址。'}</p>
          </div>
        </div>
      ` : `
        ${buildBulkToolbar({
          key: bulkKey,
          itemLabel: 'Catch-all 邮箱',
          actions: [
            { value: 'delete', label: '删除选中 Catch-all', run: () => window.bulkDeleteCatchallMailboxes(bulkKey) },
          ],
          scopeHint: '当前批量操作仅对本页 Catch-all 邮箱生效，翻页后会自动切换到新页面的可见列表。',
        })}
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th style="width:44px">选择</th><th>地址</th><th>归属</th><th>邮件数</th><th>最近邮件</th><th>过期时间</th><th>操作</th></tr>
              </thead>
              <tbody>
                ${mailboxes.length === 0 ? `
                  <tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:1.2rem">没有匹配当前筛选条件的 Catch-all 邮箱</td></tr>
                ` : mailboxes.map(mb => `
                  <tr>
                    <td style="text-align:center">
                      <input type="checkbox" data-bulk-key="${bulkKey}" data-bulk-id="${mb.id}" ${isBulkSelected(bulkKey, mb.id) ? 'checked' : ''} onchange="toggleBulkSelection('${bulkKey}','${mb.id}', this.checked)">
                    </td>
                    <td>
                      <div style="font-family:var(--font-mono);font-size:0.82rem">${escHtml(mb.full_address)}</div>
                      <div style="font-size:0.74rem;color:var(--text-muted)">创建于 ${formatDate(mb.created_at)}</div>
                    </td>
                    <td>
                      <span class="badge ${mb.owner_is_system ? 'badge-gray' : (mb.owner_is_admin ? 'badge-gold' : 'badge-gray')}">
                        ${mb.owner_is_system ? '系统账号' : (mb.owner_is_admin ? '管理员' : '普通用户')}
                      </span>
                      <div style="margin-top:0.35rem;font-size:0.76rem;color:var(--text-muted)">${escHtml(mb.owner_username || '—')}</div>
                    </td>
                    <td>${Number(mb.email_count || 0).toLocaleString()}</td>
                    <td style="font-size:0.78rem">${mb.last_received_at ? timeAgo(mb.last_received_at) : '暂无邮件'}</td>
                    <td style="font-size:0.78rem">${mb.expires_at ? formatDate(mb.expires_at) : '—'}</td>
                    <td>
                      <div style="display:flex;gap:0.4rem;flex-wrap:wrap">
                        <button class="btn btn-ghost btn-sm" onclick="openInbox('${mb.id}','${escHtml(mb.full_address)}','admin-catchall')">查看</button>
                        <button class="btn btn-ghost btn-sm" onclick="copyText('${escHtml(mb.full_address)}')">⎘</button>
                        <button class="btn btn-danger btn-sm" onclick="confirmDeleteCatchallMailbox('${mb.id}','${escHtml(mb.full_address)}')">删除</button>
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          ${buildPaginationBar({
            page: mailboxPage.page,
            size: mailboxPage.size,
            total: mailboxPage.total,
            totalPages: mailboxPage.totalPages,
            itemLabel: 'Catch-all 邮箱',
            pageSizeOptions: CATCHALL_MAILBOX_PAGE_SIZE_OPTIONS,
            onPageChange: 'setListPage',
            onPageSizeChange: 'setListPageSize',
            pagerKey: listKey,
            compact: true,
            hideIfSinglePage: true,
          })}
        </div>
      `}
    </div>
  `;
}

window.bulkDeleteAccounts = async function(selectionKey = 'admin-accounts') {
  await runBulkDelete({
    selectionKey,
    itemLabel: '账户',
    onDelete: id => api.admin.deleteAccount(id),
    onDone: async () => navigate('admin-accounts'),
  });
};

window.bulkDeleteCatchallMailboxes = async function(selectionKey = 'admin-catchall') {
  await runBulkDelete({
    selectionKey,
    itemLabel: 'Catch-all 邮箱',
    onDelete: id => api.admin.deleteCatchallMailbox(id),
    onDone: async () => navigate('admin-catchall'),
  });
};

window.confirmDeleteCatchallMailbox = function(id, addr) {
  showModal('删除 Catch-all 邮箱', `<p>确定删除 <strong>${escHtml(addr)}</strong>？<br><span style="font-size:0.8rem;color:var(--clr-danger)">该地址下所有 catch-all 邮件都会被永久删除。</span></p>`, async () => {
    try {
      await api.admin.deleteCatchallMailbox(id);
      toast('Catch-all 邮箱已删除', 'success');
      if (state.currentMailbox?.id === id) {
        state.currentMailbox = null;
      }
      navigate('admin-catchall');
    } catch (e) {
      toast('删除失败: ' + e.message, 'error');
      return false;
    }
  });
};

// ─── Admin: 域名管理 ─────────────────────────────────────────
async function renderAdminDomains(container) {
  const bulkKey = 'admin-domains';
  const controlsKey = 'admin-domains-controls';
  const actions = $('topbar-actions');
  if (actions) {
    actions.innerHTML = `
      <button class="btn btn-primary btn-sm" onclick="showAddDomainModal()">+ 手动添加</button>
      <button class="btn btn-success btn-sm" onclick="showMXRegisterModal()" style="margin-left:0.4rem">⚡ MX 自动注册</button>
    `;
  }
  clearPendingDomainPoller();

  const domains = await api.domains();
  const controlState = getListViewState(controlsKey, { page: 1, size: DOMAIN_PAGE_SIZE, q: '' });
  const query = String(controlState.q || '').trim();
  const normalizedQuery = query.toLowerCase();
  const matchDomain = (domain) => !normalizedQuery || String(domain?.domain || '').toLowerCase().includes(normalizedQuery);
  state.adminDomains = domains || [];
  const filteredDomains = (domains || []).filter(matchDomain);
  const pending  = filteredDomains.filter(d => d.status === 'pending');
  const active   = filteredDomains.filter(d => d.status !== 'pending');
  const activeGroups = splitManagedDomains(active);
  const pendingGroups = splitManagedDomains(pending);
  const pendingPage = getLocalPageData('admin-domains-pending', pending, DOMAIN_PAGE_SIZE);
  const exactPage = getLocalPageData('admin-domains-exact', activeGroups.exact, DOMAIN_PAGE_SIZE);
  const wildcardPage = getLocalPageData('admin-domains-wildcard', activeGroups.wildcard, DOMAIN_PAGE_SIZE);
  const disabledCount = active.filter(d => !d.is_active).length;
  setBulkVisibleIds(
    bulkKey,
    [...pendingPage.data, ...exactPage.data, ...wildcardPage.data].map(d => d.id),
  );

  const summaryCardsHtml = `
    <div class="stat-grid domain-overview-grid">
      <div class="stat-card">
        <div class="stat-label">精确域名</div>
        <div class="stat-value">${activeGroups.exact.length}</div>
        <div class="stat-note">根域 / 单个域名规则</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">通配规则</div>
        <div class="stat-value">${activeGroups.wildcard.length}</div>
        <div class="stat-note">接收任意子域</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">待验证</div>
        <div class="stat-value">${pending.length}</div>
        <div class="stat-note">${pending.length > 0 ? `精确 ${pendingGroups.exact.length} / 通配 ${pendingGroups.wildcard.length}` : '无待验证项'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">已停用</div>
        <div class="stat-value">${disabledCount}</div>
        <div class="stat-note">可随时重新启用</div>
      </div>
    </div>
  `;

  const exactDomainsHtml = `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">🌐 精确域名</div>
          <div class="domain-section-hint">适合根域或单独托管的业务域名</div>
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted)">共 ${activeGroups.exact.length} 个${exactPage.totalPages > 1 ? ` · 第 ${exactPage.page}/${exactPage.totalPages} 页` : ''}</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:44px">选择</th><th>域名</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            ${activeGroups.exact.length === 0 ? `<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">暂无精确域名</td></tr>` :
              exactPage.data.map(d => `
                <tr>
                  <td style="text-align:center">
                    <input type="checkbox" data-bulk-key="${bulkKey}" data-bulk-id="${d.id}" ${isBulkSelected(bulkKey, d.id) ? 'checked' : ''} onchange="toggleBulkSelection('${bulkKey}','${d.id}', this.checked)">
                  </td>
                  <td>
                    <div style="font-family:var(--font-mono)">${escHtml(d.domain)}</div>
                    <div class="domain-example-note">可直接用于 hello@${escHtml(d.domain)}</div>
                  </td>
                  <td>${d.is_active
                    ? '<span class="badge badge-green">● 启用</span>'
                    : '<span class="badge badge-gray">○ 停用</span>'}</td>
                  <td style="display:flex;gap:0.5rem;align-items:center">
                    <button class="btn btn-ghost btn-sm" onclick="toggleDomain(${d.id},${!d.is_active})">${d.is_active ? '停用' : '启用'}</button>
                    <button class="btn btn-danger btn-sm" onclick="confirmDeleteDomain(${d.id},'${escHtml(d.domain)}')">删除</button>
                  </td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
      ${buildPaginationBar({
        page: exactPage.page,
        size: exactPage.size,
        total: exactPage.total,
        totalPages: exactPage.totalPages,
        itemLabel: '精确域名',
        pageSizeOptions: DOMAIN_PAGE_SIZE_OPTIONS,
        onPageChange: 'setListPage',
        onPageSizeChange: 'setListPageSize',
        pagerKey: 'admin-domains-exact',
        compact: true,
        hideIfSinglePage: true,
      })}
    </div>
  `;

  const wildcardDomainsHtml = `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">✳ 通配子域规则</div>
          <div class="domain-section-hint">例如 <code>*.example.com</code>，适合接收任意子域但不接收根域</div>
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted)">共 ${activeGroups.wildcard.length} 个${wildcardPage.totalPages > 1 ? ` · 第 ${wildcardPage.page}/${wildcardPage.totalPages} 页` : ''}</div>
      </div>
      <div class="table-wrap">
        <table class="wildcard-domain-table">
          <thead><tr><th style="width:44px">选择</th><th>规则</th><th>匹配示例</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            ${activeGroups.wildcard.length === 0 ? `<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">暂无通配规则</td></tr>` :
              wildcardPage.data.map(d => `
                <tr>
                  <td style="text-align:center">
                    <input type="checkbox" data-bulk-key="${bulkKey}" data-bulk-id="${d.id}" ${isBulkSelected(bulkKey, d.id) ? 'checked' : ''} onchange="toggleBulkSelection('${bulkKey}','${d.id}', this.checked)">
                  </td>
                  <td class="domain-rule-cell">
                    <div class="domain-rule-code" title="${escHtml(d.domain)}">${escHtml(d.domain)}</div>
                    <div style="margin-top:0.3rem">${renderDomainTypeHtml(d.domain)}</div>
                  </td>
                  <td class="domain-example-cell">${renderWildcardExamplesHtml(d.domain)}</td>
                  <td>${d.is_active
                    ? '<span class="badge badge-green">● 启用</span>'
                    : '<span class="badge badge-gray">○ 停用</span>'}</td>
                  <td style="display:flex;gap:0.5rem;align-items:center">
                    <button class="btn btn-ghost btn-sm" onclick="toggleDomain(${d.id},${!d.is_active})">${d.is_active ? '停用' : '启用'}</button>
                    <button class="btn btn-danger btn-sm" onclick="confirmDeleteDomain(${d.id},'${escHtml(d.domain)}')">删除</button>
                  </td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
      ${buildPaginationBar({
        page: wildcardPage.page,
        size: wildcardPage.size,
        total: wildcardPage.total,
        totalPages: wildcardPage.totalPages,
        itemLabel: '通配规则',
        pageSizeOptions: DOMAIN_PAGE_SIZE_OPTIONS,
        onPageChange: 'setListPage',
        onPageSizeChange: 'setListPageSize',
        pagerKey: 'admin-domains-wildcard',
        compact: true,
        hideIfSinglePage: true,
      })}
    </div>
  `;

  container.innerHTML = `
    <div class="page-stack page-stack-wide">
      ${buildListFilterBar({
        key: controlsKey,
        searchValue: query,
        searchPlaceholder: '搜索域名或通配规则，例如 *.example.com',
        searchButtonLabel: '搜索域名',
        hint: '支持按精确域名或通配规则关键词筛选当前管理列表。',
      })}
      ${filteredDomains.length > 0 ? buildBulkToolbar({
        key: bulkKey,
        itemLabel: '域名',
        actions: [
          { value: 'enable', label: '启用选中域名', run: () => window.bulkToggleDomains(bulkKey, true) },
          { value: 'disable', label: '停用选中域名', run: () => window.bulkToggleDomains(bulkKey, false) },
          { value: 'delete', label: '删除选中域名', run: () => window.bulkDeleteDomains(bulkKey) },
        ],
        scopeHint: '当前仅对本页各分区中可见的域名生效；启用/停用会自动跳过待验证域名，翻页后可见范围会更新。',
      }) : ''}
      ${summaryCardsHtml}
      <div class="card" style="border-left:3px solid var(--clr-primary,#b85c38)">
        <div class="card-body" style="padding:0.85rem 1rem;font-size:0.8rem;color:var(--text-secondary)">
          支持直接添加通配规则 <code>*.example.com</code>。该规则会接收任意子域邮件（如 <code>@a.example.com</code>、<code>@b.c.example.com</code>），但<strong>不会</strong>覆盖根域 <code>@example.com</code>。
        </div>
      </div>
      ${pending.length > 0 ? `
        <div class="card" style="border-left:3px solid var(--clr-warn,#e6a817)">
          <div class="card-header">
            <div class="card-title">🔄 待 MX 验证 (${pending.length})</div>
            <div style="font-size:0.78rem;color:var(--text-muted)">后台每 30 秒自动检测，验证通过后自动加入域名池${pendingPage.totalPages > 1 ? ` · 第 ${pendingPage.page}/${pendingPage.totalPages} 页` : ''}</div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th style="width:44px">选择</th><th>域名</th><th>类型</th><th>上次检测</th><th>操作</th></tr></thead>
              <tbody id="pending-domains-tbody">
                ${pendingPage.data.map(d => `
                  <tr id="pending-row-${d.id}">
                    <td style="text-align:center">
                      <input type="checkbox" data-bulk-key="${bulkKey}" data-bulk-id="${d.id}" ${isBulkSelected(bulkKey, d.id) ? 'checked' : ''} onchange="toggleBulkSelection('${bulkKey}','${d.id}', this.checked)">
                    </td>
                    <td style="font-family:var(--font-mono)">${escHtml(d.domain)}</td>
                    <td>${renderDomainTypeHtml(d.domain)}</td>
                    <td style="font-size:0.78rem">${d.mx_checked_at ? timeAgo(d.mx_checked_at) : '从未'}</td>
                    <td>
                      <span class="badge badge-gold" id="pending-status-${d.id}">⏳ 检测中</span>
                      <button class="btn btn-danger btn-sm" style="margin-left:0.4rem" onclick="confirmDeleteDomain(${d.id},'${escHtml(d.domain)}')">✕</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          ${buildPaginationBar({
            page: pendingPage.page,
            size: pendingPage.size,
            total: pendingPage.total,
            totalPages: pendingPage.totalPages,
            itemLabel: '待验证域名',
            pageSizeOptions: DOMAIN_PAGE_SIZE_OPTIONS,
            onPageChange: 'setListPage',
            onPageSizeChange: 'setListPageSize',
            pagerKey: 'admin-domains-pending',
            compact: true,
            hideIfSinglePage: true,
          })}
        </div>
      ` : ''}

      <div class="domain-sections-grid">
        ${exactDomainsHtml}
        ${wildcardDomainsHtml}
      </div>
    </div>
  `;

  // 如果有 pending 域名，开始轮询
  if (pending.length > 0) {
    startPendingDomainPoller(pending.map(d => d.id));
  }
}

window.bulkDeleteDomains = async function(selectionKey = 'admin-domains') {
  await runBulkDelete({
    selectionKey,
    itemLabel: '域名',
    onDelete: id => api.admin.deleteDomain(id),
    onDone: async () => navigate('admin-domains'),
  });
};

window.bulkToggleDomains = function(selectionKey = 'admin-domains', newActive) {
  const selectedIds = getBulkSelectedIds(selectionKey);
  if (!selectedIds.length) {
    toast('请先选择域名', 'warn');
    return;
  }
  const selectedDomains = (state.adminDomains || []).filter(d => selectedIds.includes(String(d.id)));
  const eligible = selectedDomains.filter(d => d.status !== 'pending');
  const skipped = selectedDomains.length - eligible.length;
  if (!eligible.length) {
    toast('待验证域名不能直接批量启用/停用', 'warn');
    return;
  }
  const actionLabel = newActive ? '启用' : '停用';
  showModal(`批量${actionLabel}域名`, `<p>确定${actionLabel}选中的 <strong>${eligible.length}</strong> 个域名？${skipped > 0 ? `<br><span style="font-size:0.8rem;color:var(--text-muted)">其中 ${skipped} 个待验证域名会被自动跳过。</span>` : ''}</p>`, async () => {
    let success = 0;
    let failed = 0;
    for (const domain of eligible) {
      try {
        await api.admin.toggleDomain(domain.id, newActive);
        success += 1;
      } catch {
        failed += 1;
      }
    }
    getBulkSelection(selectionKey).clear();
    if (success > 0) toast(`已${actionLabel} ${success} 个域名`, 'success');
    if (failed > 0) toast(`${failed} 个域名${actionLabel}失败`, 'warn');
    navigate('admin-domains');
  });
};

window.showAddDomainModal = function() {
  const old = document.querySelector('.modal-overlay');
  if (old) old.remove();

  let serverIP = '';
  let serverHostname = '';
  api.publicSettings().then(s => {
    serverIP = s.smtp_server_ip || '';
    serverHostname = s.smtp_hostname || '';
    updateDnsHint();
  }).catch(() => {});

  const overlay = el('div', 'modal-overlay');
  overlay.innerHTML = `
    <div class="modal" style="max-width:580px">
      <div class="modal-title">添加域名</div>
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>

      <div id="add-step1">
        <div class="form-group" style="margin-bottom:0.5rem">
          <label class="form-label">域名</label>
          <input class="form-input" id="add-domain-inp" placeholder="example.com 或 *.example.com" autofocus />
          <div class="form-hint">支持精确域名和通配子域规则。通配规则如 <code>*.example.com</code>，只覆盖子域，不覆盖根域 <code>example.com</code>。</div>
        </div>
        <div id="add-dns-hint" style="background:var(--bg-secondary);border-radius:6px;padding:0.7rem 0.9rem;margin-bottom:0.8rem;font-size:0.8rem">
          <b>需要配置的 DNS 记录：</b>
          <table style="margin-top:0.5rem;width:100%;border-collapse:collapse;font-size:0.76rem">
            <thead><tr><th style="text-align:left;padding:2px 5px">类型</th><th style="text-align:left;padding:2px 5px">主机名</th><th style="text-align:left;padding:2px 5px">内容</th><th style="text-align:left;padding:2px 5px">优先级</th></tr></thead>
            <tbody id="add-dns-rows"></tbody>
          </table>
        </div>
        <div id="add-mx-result" style="display:none;margin-bottom:0.7rem"></div>
        <div class="modal-actions" id="add-actions">
          <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">取消</button>
          <button class="btn btn-secondary" id="add-check-btn" onclick="doAddDomainCheck(false)">🔍 检测 MX</button>
          <button class="btn btn-primary"  id="add-force-btn" style="display:none" onclick="doAddDomainCheck(true)">⚡ 强制添加</button>
        </div>
      </div>

      <div id="add-step2" style="display:none"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const inp = overlay.querySelector('#add-domain-inp');
  inp?.addEventListener('keydown', e => { if (e.key === 'Enter') window.doAddDomainCheck(false); });
  inp?.addEventListener('input', updateDnsHint);

  function updateDnsHint() {
    const rawDomain = normalizeDomainInput(inp?.value || '') || 'example.com';
    const wildcard = isWildcardDomainPattern(rawDomain);
    const baseDomain = wildcard ? (getWildcardBaseDomain(rawDomain) || 'example.com') : rawDomain;
    const ip = serverIP || '&lt;服务器IP&gt;';
    const hn = serverHostname || 'mail.' + baseDomain;
    const hasHostname = !!serverHostname;
    const mxHost = wildcard ? '*' : '@';
    const txtHost = wildcard ? '*' : '@';
    const tbody = document.getElementById('add-dns-rows');
    if (!tbody) return;
    tbody.innerHTML = `
      <tr><td style="padding:2px 5px">MX</td><td style="padding:2px 5px;font-family:monospace">${mxHost}</td><td style="padding:2px 5px;font-family:monospace">${escHtml(hn)}</td><td style="padding:2px 5px">10</td></tr>
      ${hasHostname ? '' : `<tr><td style="padding:2px 5px">A</td><td style="padding:2px 5px;font-family:monospace">mail.${escHtml(baseDomain)}</td><td style="padding:2px 5px;font-family:monospace">${escHtml(ip)}</td><td style="padding:2px 5px">—</td></tr>`}
      <tr><td style="padding:2px 5px">TXT</td><td style="padding:2px 5px;font-family:monospace">${txtHost}</td><td style="padding:2px 5px;font-family:monospace">v=spf1 ip4:${escHtml(ip)} ~all</td><td style="padding:2px 5px">—</td></tr>
      ${wildcard ? `<tr><td colspan="4" style="padding:6px 5px 2px;color:var(--text-muted)">提示：该通配规则不覆盖根域 <code>${escHtml(baseDomain)}</code>，如需接收 <code>@${escHtml(baseDomain)}</code> 请额外再添加一次精确域名。</td></tr>` : ''}
    `;
  }
  updateDnsHint();

  window.doAddDomainCheck = async function(force) {
    const domain = (inp?.value || '').trim().toLowerCase();
    if (!domain) { toast('请输入域名', 'warn'); return; }
    const checkBtn = document.getElementById('add-check-btn');
    const forceBtn = document.getElementById('add-force-btn');
    const resEl    = document.getElementById('add-mx-result');
    if (checkBtn) { checkBtn.disabled = true; checkBtn.textContent = '检测中...'; }

    try {
      if (force) {
        // 强制直接添加（跳过 MX 检测）
        const r = await api.admin.addDomain({ domain });
        showDnsInstructions(domain, r);
        overlay.remove();
        return;
      }

      // 先做 MX 检测（force:false）
      let r;
      try {
        r = await api.admin.mxImport({ domain, force: false });
        // MX 通过 → 已添加
        const step1 = document.getElementById('add-step1');
        const step2 = document.getElementById('add-step2');
        if (step1) step1.style.display = 'none';
        if (step2) {
          step2.style.display = 'block';
          step2.innerHTML = `
            <div style="text-align:center;padding:1.2rem 0">
              <div style="font-size:2rem">✅</div>
              <h3 style="margin:0.5rem 0">MX 验证通过</h3>
              <p style="font-size:0.84rem;color:var(--text-secondary)">域名 <strong>${escHtml(domain)}</strong> 已立即加入域名池</p>
              <button class="btn btn-primary" style="margin-top:1rem" onclick="this.closest('.modal-overlay').remove();navigate('admin-domains')">查看域名列表</button>
            </div>`;
        }
        toast('✓ ' + domain + ' MX 验证通过，已加入域名池', 'success');
      } catch(err) {
        // MX 未通过 → 提示强制添加选项
        if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = '🔍 检测 MX'; }
        if (forceBtn) forceBtn.style.display = '';
        if (resEl) {
          resEl.style.display = 'block';
          resEl.innerHTML = `
            <div style="background:var(--clr-warn-bg,#fff8e1);border:1px solid var(--clr-warn,#e6a817);border-radius:6px;padding:0.6rem 0.9rem;font-size:0.82rem">
              ⚠️ <b>MX 记录未检测到</b>：${escHtml(err.message)}<br>
              <span style="color:var(--text-muted)">请先配置上方 DNS 记录后重新检测，或点击「强制添加」跳过检测直接加入域名池</span>
            </div>`;
        }
      }
    } catch(e) {
      if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = '🔍 检测 MX'; }
      toast('操作失败: ' + e.message, 'error');
    }
  };
};

// \u5c55\u793a\u6dfb\u52a0\u57df\u540d\u540e\u7684 DNS \u914d\u7f6e\u6307\u5f15
function showDnsInstructions(domain, result) {
  const dns = result.dns_records || [];
  const rows = dns.map(r => `
    <tr>
      <td style="padding:3px 8px;font-weight:600">${escHtml(r.type)}</td>
      <td style="padding:3px 8px">${escHtml(r.host)}</td>
      <td style="padding:3px 8px;font-family:monospace;font-size:0.78rem">${escHtml(r.value)}</td>
      <td style="padding:3px 8px">${r.priority || '\u2014'}</td>
    </tr>`).join('');
  const old = document.querySelector('.modal-overlay');
  if (old) old.remove();
  const overlay = el('div', 'modal-overlay');
  overlay.innerHTML = `
    <div class="modal" style="max-width:600px">
      <div class="modal-title">\u2705 \u57df\u540d\u5df2\u6dfb\u52a0\uff1a${escHtml(domain)}</div>
      <p style="font-size:0.84rem;color:var(--text-secondary);margin:0.5rem 0 0.8rem">
        \u8bf7\u5728 DNS \u7ba1\u7406\u9762\u677f\u6dfb\u52a0\u4ee5\u4e0b\u8bb0\u5f55\uff0c\u4e00\u822c 5\u201330 \u5206\u949f\u751f\u6548\uff1a
      </p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>\u7c7b\u578b</th><th>\u4e3b\u673a\u540d</th><th>\u5185\u5bb9</th><th>\u4f18\u5148\u7ea7</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p style="font-size:0.78rem;color:var(--text-muted);margin-top:0.6rem">\u2139\ufe0f ${escHtml(result.instructions || '')}</p>
      <div class="modal-actions">
        <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove();navigate('admin-domains')">
          \u5b8c\u6210\uff0c\u67e5\u770b\u57df\u540d\u5217\u8868
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); navigate('admin-domains'); }});
}

window.toggleDomain = async function(id, newActive) {
  try {
    await api.admin.toggleDomain(id, newActive);
    toast('状态已切换', 'success');
    navigate('admin-domains');
  } catch(e) { toast('操作失败: ' + e.message, 'error'); }
};

window.confirmDeleteDomain = function(id, name) {
  showModal('删除域名', `<p>确定删除域名 <strong>${escHtml(name)}</strong>？</p>`, async () => {
    try {
      await api.admin.deleteDomain(id);
      toast('域名已删除', 'success');
      navigate('admin-domains');
    } catch(e) { toast('删除失败: ' + e.message, 'error'); }
  });
};

// ─── Admin: 系统设置 ─────────────────────────────────────────
async function renderAdminSettings(container) {
  let settings = {};
  let accounts = [];
  try {
    [settings, accounts] = await Promise.all([
      api.admin.getSettings(),
      api.admin.listAllAccounts(),
    ]);
  } catch {
    try { settings = await api.admin.getSettings(); } catch {}
    try { accounts = await api.admin.listAllAccounts(); } catch {}
  }

  const regOpen    = settings.registration_open === 'true' || settings.registration_open === true;
  const smtpIp      = settings.smtp_server_ip       || '';
  const smtpHostname = settings.smtp_hostname         || '';
  const siteTitle  = settings.site_title            || DEFAULT_SITE_TITLE;
  const siteLogo   = settings.site_logo             || DEFAULT_SITE_LOGO;
  const siteSubtitle = settings.site_subtitle       || DEFAULT_SITE_SUBTITLE;
  const defDomain  = settings.default_domain        || '';
  const ttlMins    = settings.mailbox_ttl_minutes   || '30';
  const announce   = settings.announcement          || '';
  const maxMb      = settings.max_mailboxes_per_user|| '5';
  const reservedMailboxAddresses = settings.reserved_mailbox_addresses ?? DEFAULT_RESERVED_MAILBOX_ADDRESSES;
  const subdomainWordlist = settings.subdomain_wordlist || '';
  const unknownPolicy = settings.unknown_recipient_policy || 'claimable';
  const catchallAdminId = settings.catchall_admin_account_id || '';
  const adminAccounts = (accounts || []).filter(a => a.is_admin && a.is_active && !a.is_system);

  function inputRow(id, label, value, hint, placeholder = '', settingKey = '') {
    const key = settingKey || id.replace(/^input-/, '').replace(/-/g, '_');
    return `
      <div class="form-group">
        <label class="form-label">${label}</label>
        <div style="display:flex;gap:0.5rem">
          <input class="form-input" id="${id}" value="${escHtml(value)}" placeholder="${escHtml(placeholder)}" style="flex:1" />
          <button class="btn btn-primary btn-sm" onclick="saveSetting('${id}','${key}')">✓ 保存</button>
        </div>
        ${hint ? `<div class="form-hint">${hint}</div>` : ''}
      </div>`;
  }

  container.innerHTML = `
    <div class="card" style="max-width:640px">
      <div class="card-header"><div class="card-title">⚙ 系统设置</div></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:0.1rem">

        <!-- 注册开关 -->
        <div class="toggle-wrap" style="margin-bottom:0.5rem">
          <label class="toggle">
            <input type="checkbox" id="toggle-reg" ${regOpen ? 'checked' : ''} onchange="saveRegistrationSetting(this.checked)">
            <span class="toggle-slider"></span>
          </label>
          <div>
            <div class="toggle-label">开放自行注册</div>
            <span class="toggle-desc">开启后未登录用户可在登录页自行注册账户</span>
          </div>
        </div>
        <div class="divider"></div>

        <!-- 站点名称 -->
        ${inputRow('input-site-title', '站点名称', siteTitle, '显示在标题栏和登录页', 'TempMail')}
        <div class="divider"></div>

        <!-- 站点 Logo -->
        ${inputRow('input-site-logo', '站点 Logo', siteLogo, '支持 emoji 或 1-2 个字符，显示在登录页和侧边栏品牌位', '✉', 'site_logo')}
        <div class="divider"></div>

        <!-- 站点副标题 -->
        ${inputRow('input-site-subtitle', '站点副标题', siteSubtitle, '显示在登录页标题下方与侧边栏品牌描述', '临时邮箱服务 · 安全隔离 · 按需分配', 'site_subtitle')}
        <div class="divider"></div>

        <!-- 公告 -->
        <div class="form-group">
          <label class="form-label">公告内容</label>
          <div style="display:flex;gap:0.5rem">
            <textarea class="form-input" id="input-announcement" rows="2" placeholder="留空则不显示公告" style="flex:1;resize:vertical">${escHtml(announce)}</textarea>
            <button class="btn btn-primary btn-sm" onclick="saveSetting('input-announcement','announcement')" style="align-self:flex-start">✓ 保存</button>
          </div>
          <div class="form-hint">显示在已登录用户的 Dashboard 顶部</div>
        </div>
        <div class="divider"></div>

        <!-- SMTP IP -->
        ${inputRow('input-smtp-ip', 'SMTP 服务器公网 IP', smtpIp, '用于生成 SPF DNS 配置提示', '0.0.0.0', 'smtp_server_ip')}
        <div class="divider"></div>

        <!-- SMTP Hostname -->
        ${inputRow('input-smtp-hostname', '邮件服务器主机名', smtpHostname, '用作 MX 记录目标（如 mail.yourdomain.com）。设置后用户添加域名只需一条 MX 记录，无需额外 A 记录。', 'mail.yourdomain.com', 'smtp_hostname')}
        <div class="divider"></div>

        <!-- 默认邮箱域名 -->
        ${inputRow('input-default-domain', '默认邮箱域名', defDomain, '创建邮箱时下拉框优先选中的域名', 'mail.example.com')}
        <div class="divider"></div>

        <!-- 邮箱 TTL -->
        ${inputRow('input-mailbox-ttl-minutes', '邮箱有效期（分钟）', ttlMins, '仅对临时邮箱生效；永久邮箱不会自动过期', '30')}
        <div class="divider"></div>

        <!-- 每用户邮箱上限 -->
        ${inputRow('input-max-mailboxes-per-user', '每账户邮箱上限', maxMb, '每个账户同时存在的邮箱数量上限', '5')}
        <div class="divider"></div>

        <!-- 保留邮箱前缀 -->
        <div class="form-group">
          <label class="form-label">普通用户保留地址</label>
          <div style="display:flex;gap:0.5rem">
            <textarea class="form-input" id="input-reserved-mailbox-addresses" rows="6" placeholder="每行一个本地部分，如 admin" style="flex:1;resize:vertical">${escHtml(reservedMailboxAddresses)}</textarea>
            <button class="btn btn-primary btn-sm" onclick="saveSetting('input-reserved-mailbox-addresses','reserved_mailbox_addresses')" style="align-self:flex-start">✓ 保存</button>
          </div>
          <div class="form-hint">这些邮箱前缀仅管理员可创建。支持换行、逗号、空格或分号分隔；留空表示不保留任何特殊地址。</div>
        </div>
        <div class="divider"></div>

        <!-- 通配子域词库 -->
        <div class="form-group">
          <label class="form-label">通配子域词库（wordlist 模式）</label>
          <div style="display:flex;gap:0.5rem">
            <textarea class="form-input" id="input-subdomain-wordlist" rows="10" placeholder="每行一个完整子域标签，如 api 或 support-center" style="flex:1;resize:vertical">${escHtml(subdomainWordlist)}</textarea>
            <button class="btn btn-primary btn-sm" onclick="saveSetting('input-subdomain-wordlist','subdomain_wordlist')" style="align-self:flex-start">✓ 保存</button>
          </div>
          <div class="form-hint">用于通配域名的“词库随机”模式。建议填写常见完整子域标签，例如 <code>api</code>、<code>auth-center</code>、<code>support-hub</code>。支持换行、逗号、空格或分号分隔；留空会回退到内置默认词库。</div>
        </div>
        <div class="divider"></div>

        <!-- 未知收件人策略 -->
        <div class="form-group">
          <label class="form-label">未知收件人处理方式</label>
          <div style="display:flex;gap:0.5rem">
            <select class="form-input" id="input-unknown-recipient-policy" style="flex:1">
              <option value="claimable" ${unknownPolicy === 'claimable' ? 'selected' : ''}>弱所有权：自动存入 catch-all，后续可认领</option>
              <option value="admin_only" ${unknownPolicy === 'admin_only' ? 'selected' : ''}>管理员 catch-all：普通用户不可认领</option>
            </select>
            <button class="btn btn-primary btn-sm" onclick="saveSetting('input-unknown-recipient-policy','unknown_recipient_policy')">✓ 保存</button>
          </div>
        <div class="form-hint">claimable 适合 temp-mail 式使用；admin_only 会把新出现的未知地址邮件转交给最早创建的活跃管理员账户。</div>
        </div>
        <div class="divider"></div>

        <!-- Catch-all 管理员 -->
        <div class="form-group">
          <label class="form-label">指定 Catch-all 管理员</label>
          <div style="display:flex;gap:0.5rem">
            <select class="form-input" id="input-catchall-admin-account-id" style="flex:1">
              <option value="">自动选择最早创建的活跃管理员</option>
              ${adminAccounts.map(acc => `
                <option value="${escHtml(acc.id)}" ${catchallAdminId === acc.id ? 'selected' : ''}>
                  ${escHtml(acc.username)}${acc.id === state.account?.id ? '（当前账号）' : ''}
                </option>
              `).join('')}
            </select>
            <button class="btn btn-primary btn-sm" onclick="saveSetting('input-catchall-admin-account-id','catchall_admin_account_id')">✓ 保存</button>
          </div>
          <div class="form-hint">仅在 admin_only 模式生效。留空时，系统自动选用最早创建的活跃管理员。</div>
        </div>
        <div class="divider"></div>

        <!-- 服务信息 -->
        <div style="font-size:0.82rem;color:var(--text-secondary)">
          <strong>服务信息</strong>
          <p style="margin-top:0.5rem;line-height:2">
            SMTP IP:&nbsp;<code>${escHtml(smtpIp||'<未设置>')}</code><br>
            邮件主机名:&nbsp;<code>${escHtml(smtpHostname||'<未设置>')}</code><br>
            API:&nbsp;<code>${window.location.origin}/api</code><br>
            前端:&nbsp;<code>${window.location.origin}</code>
          </p>
        </div>
        <div class="divider"></div>

        <!-- 管理员 Key -->
        <div>
          <div class="form-label">管理员 API Key</div>
          <div class="code-box" style="font-size:0.78rem">
            <span style="filter:blur(4px);cursor:pointer" onclick="this.style.filter='none'">${escHtml(state.apiKey)}</span>
            <button class="copy-btn" onclick="copyText('${escHtml(state.apiKey)}')">⎘</button>
          </div>
          <div class="form-hint">Key 文件位置：<code>/data/admin.key</code>（API 服务容器内）</div>
        </div>

      </div>
    </div>
  `;
}

// 通用保存
window.saveSetting = async function(inputId, settingKey) {
  const el2 = document.getElementById(inputId);
  const val = el2 ? (el2.tagName === 'TEXTAREA' ? el2.value : el2.value.trim()) : '';
  try {
    await api.admin.saveSettings({ [settingKey]: val });
    if (['site_title', 'site_logo', 'site_subtitle'].includes(settingKey)) {
      state.publicSettings = {
        ...(state.publicSettings || {}),
        [settingKey]: val || (
          settingKey === 'site_title' ? DEFAULT_SITE_TITLE :
          settingKey === 'site_logo' ? DEFAULT_SITE_LOGO :
          DEFAULT_SITE_SUBTITLE
        ),
      };
      applySiteBranding(
        state.publicSettings.site_title,
        state.publicSettings.site_logo,
        state.publicSettings.site_subtitle,
      );
    }
    toast('已保存', 'success');
  } catch(e) { toast('保存失败: ' + e.message, 'error'); }
};

// 兼容旧调用
window.saveSmtpIp = async function() { await window.saveSetting('input-smtp-ip', 'smtp_server_ip'); };

window.saveRegistrationSetting = async function(enabled) {
  try {
    await api.admin.saveSettings({ registration_open: enabled ? 'true' : 'false' });
    toast(`注册已${enabled ? '开启' : '关闭'}`, 'success');
  } catch(e) {
    toast('保存失败: ' + e.message, 'error');
    const cb = $('toggle-reg');
    if (cb) cb.checked = !enabled;
  }
};

// ─── Modal ────────────────────────────────────────────────
function showModal(title, bodyHtml, onConfirm) {
  const old = document.querySelector('.modal-overlay');
  if (old) old.remove();

  const overlay = el('div', 'modal-overlay');
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">${escHtml(title)}</div>
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      ${bodyHtml}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">取消</button>
        <button class="btn btn-primary" id="modal-confirm-btn">确认</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const confirmBtn = overlay.querySelector('#modal-confirm-btn');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const result = await onConfirm();
    if (result !== false) overlay.remove();
    else confirmBtn.disabled = false;
  });
}

// ─── MX 自动注册（全自动验证流程）──────────────────────────
// 轮询待验证域名状态
let _pendingPollerTimer = null;
let _inboxPollerTimer   = null;
function clearInboxPoller() {
  if (_inboxPollerTimer) { clearInterval(_inboxPollerTimer); _inboxPollerTimer = null; }
}
function clearPendingDomainPoller() {
  if (_pendingPollerTimer) { clearInterval(_pendingPollerTimer); _pendingPollerTimer = null; }
}
function startPendingDomainPoller(ids) {
  if (!ids || ids.length === 0) {
    clearPendingDomainPoller();
    return;
  }
  clearPendingDomainPoller();
  const remaining = new Set(ids);
  _pendingPollerTimer = setInterval(async () => {
    if (!['domains-guide', 'admin-domains'].includes(state.page)) {
      clearPendingDomainPoller();
      return;
    }
    if (document.hidden) return;

    for (const id of [...remaining]) {
      try {
        const d = await api.getDomainStatus(id); // 使用非管理员接口
        const statusEl = document.getElementById('pending-status-' + id);
        const rowEl    = document.getElementById('pending-row-'   + id);
        if (d.status === 'active') {
          if (statusEl) statusEl.innerHTML = '<span class="badge badge-green">✓ 已激活</span>';
          remaining.delete(id);
          getBulkSelection('admin-domains').delete(String(id));
          updateBulkUI('admin-domains');
          toast(`✓ 域名 ${d.domain} MX验证通过，已加入域名池`, 'success');
          setTimeout(() => { if (rowEl) rowEl.remove(); }, 3000);
        } else if (statusEl) {
          const ago = d.mx_checked_at ? timeAgo(d.mx_checked_at) : '从未';
          statusEl.innerHTML = `<span class="badge badge-gold">⏳ 检测中（上次${ago}）</span>`;
        }
      } catch {}
    }
    if (remaining.size === 0) clearPendingDomainPoller();
  }, 15000);
}

window.showMXRegisterModal = function() {
  const old = document.querySelector('.modal-overlay');
  if (old) old.remove();
  const overlay = el('div', 'modal-overlay');
  overlay.innerHTML = `
    <div class="modal" style="max-width:560px">
      <div class="modal-title">⚡ MX 自动注册域名</div>
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      <p style="font-size:0.82rem;color:var(--text-secondary);margin:0.5rem 0 0.8rem">
        提交域名后系统立即检测 MX 记录。若已配置则直接激活；
        否则进入待验证队列，后台每 <b>30 秒</b>自动重试，无需手动确认。也支持提交 <code>*.example.com</code> 这样的通配子域规则。
      </p>
      <div class="form-group">
        <label class="form-label">域名 / 通配规则（如 example.com 或 *.example.com）</label>
        <input class="form-input" id="mxr-domain" placeholder="example.com 或 *.example.com" autofocus />
      </div>
      <div id="mxr-dns-hint" style="display:none;background:var(--bg-secondary);border-radius:6px;padding:0.7rem 0.9rem;margin-bottom:0.6rem;font-size:0.8rem">
        <b>请在 DNS 管理面板添加以下记录：</b>
        <table style="margin-top:0.5rem;width:100%;border-collapse:collapse;font-size:0.76rem">
          <thead><tr><th style="text-align:left">类型</th><th style="text-align:left">主机名</th><th style="text-align:left">内容</th><th style="text-align:left">优先级</th></tr></thead>
          <tbody id="mxr-dns-rows"></tbody>
        </table>
      </div>
      <div id="mxr-status" style="display:none;margin-bottom:0.7rem"></div>
      <div class="modal-actions" id="mxr-actions">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">取消</button>
        <button class="btn btn-primary" id="mxr-submit">提交检测</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  // 实时更新 DNS 提示
  const inp = overlay.querySelector('#mxr-domain');
  inp?.addEventListener('keydown', e => { if (e.key === 'Enter') submitMXRegister(); });

  overlay.querySelector('#mxr-submit').addEventListener('click', submitMXRegister);

  async function submitMXRegister() {
    const domain = (inp?.value || '').trim().toLowerCase();
    if (!domain) { toast('请输入域名', 'warn'); return; }
    const btn    = overlay.querySelector('#mxr-submit');
    const status = overlay.querySelector('#mxr-status');
    const hint   = overlay.querySelector('#mxr-dns-hint');
    btn.disabled = true;
    btn.textContent = '检测中...';
    status.style.display = 'none';

    const domainListPage = state.account?.is_admin ? 'admin-domains' : 'domains-guide';
    try {
      const r = await api.submitDomain({ domain }); // 任意已登录用户可用
      if (r.status === 'active') {
        overlay.innerHTML = `
          <div class="modal" style="text-align:center;padding:2rem">
            <div style="font-size:2rem">✅</div>
            <h3 style="margin:0.5rem 0">MX 验证通过</h3>
            <p style="font-size:0.84rem;color:var(--text-secondary)">域名 <strong>${escHtml(domain)}</strong> 已立即加入域名池</p>
            <button class="btn btn-primary" style="margin-top:1rem" onclick="this.closest('.modal-overlay').remove();navigate('${domainListPage}')">查看域名列表</button>
          </div>
        `;
        toast(`✓ ${domain} 已激活`, 'success');
      } else {
        // pending — 显示 DNS 配置 + 等待提示
        const rows = (r.dns_required || []).map(rec =>
          `<tr><td>${escHtml(rec.type)}</td><td style="font-family:monospace">${escHtml(rec.host)}</td><td style="font-family:monospace">${escHtml(rec.value)}</td><td>${rec.priority || '—'}</td></tr>`
        ).join('');
        overlay.querySelector('#mxr-dns-rows').innerHTML = rows;
        hint.style.display = 'block';

        status.style.display = 'block';
        status.innerHTML = `
          <div style="background:var(--clr-warn-bg,#fff8e1);border:1px solid var(--clr-warn,#e6a817);border-radius:6px;padding:0.6rem 0.9rem;font-size:0.81rem">
            ⏳ <b>域名已加入验证队列（ID ${r.domain.id}）</b><br>
            MX 记录配置生效后（通常 5-30 分钟），系统将自动激活。<br>
            <span style="color:var(--text-muted)">此窗口关闭后可在「域名列表」页查看验证进度</span>
          </div>
        `;
        const actionsEl = overlay.querySelector('#mxr-actions');
        actionsEl.innerHTML = `<button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove();navigate('${domainListPage}')">前往域名列表查看进度</button>`;

        // 开始在当前 overlay 内轮询
        startInlinePoller(r.domain.id, domain, overlay);
      }
    } catch(e) {
      btn.disabled = false;
      btn.textContent = '重新提交';
      status.style.display = 'block';
      status.innerHTML = `<div style="color:var(--clr-danger);font-size:0.82rem">❌ ${escHtml(e.message)}</div>`;
    }
  }

  async function startInlinePoller(domainId, domainName, modal) {
    const statusEl = modal.querySelector('#mxr-status');
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      if (!document.body.contains(modal)) { clearInterval(timer); return; }
      if (document.hidden) return;
      try {
        const d = await api.getDomainStatus(domainId); // 非管理员接口
        if (d.status === 'active') {
          clearInterval(timer);
          if (statusEl) statusEl.innerHTML = `
            <div style="background:#e8f5e9;border:1px solid #4caf50;border-radius:6px;padding:0.6rem 0.9rem;font-size:0.81rem">
              ✅ <b>MX 验证通过！域名 ${escHtml(domainName)} 已自动激活。</b>
            </div>`;
          toast(`✓ ${domainName} 已自动激活`, 'success');
          setTimeout(() => { modal.remove(); navigate(state.account?.is_admin ? 'admin-domains' : 'domains-guide'); }, 2500);
        } else if (statusEl) {
          const ago = d.mx_checked_at ? timeAgo(d.mx_checked_at) : '从未';
          statusEl.innerHTML = `
            <div style="background:var(--clr-warn-bg,#fff8e1);border:1px solid var(--clr-warn,#e6a817);border-radius:6px;padding:0.6rem 0.9rem;font-size:0.81rem">
              ⏳ 等待中（第 ${attempts} 次检测，上次 ${ago}）…
            </div>`;
        }
      } catch {}
    }, 15000);
  }
};

// ─── API 文档 ─────────────────────────────────────────
function renderApiDocs(container) {
  const key = state.apiKey || 'YOUR_API_KEY';
  const base = window.location.origin;
  const sections = [
    {
      title: '🔐 认证方式',
      desc: '所有 /api/* 接口需要在 HTTP Header 中携带 API Key：',
      code: `# Bearer Token 方式
curl -H "Authorization: Bearer ${key}" ${base}/api/me

# Query 参数方式
curl "${base}/api/me?api_key=${key}"`,
    },
    {
      title: '🌐 域名参数说明',
      desc: 'domain 支持根域、普通子域和通配规则；不要求必须是注册意义上的顶级域。',
      code: `# 下面这些都可以作为合法示例（前提：已在系统中激活，且 DNS 由你控制）
example.com
mail.example.com
relay.mail.example.net
*.example.com
*.mail.example.net

# 匹配关系
mail.example.com     -> 只匹配 @mail.example.com
*.mail.example.net   -> 匹配 @a.mail.example.net
*.mail.example.net   -> 也匹配 @b.c.mail.example.net
*.mail.example.net   -> 不匹配 @mail.example.net

# 如果你想同时接收 @mail.example.net 和任意更深子域：
mail.example.net
*.mail.example.net`,
    },
    {
      title: '📫 1. 创建邮箱（临时 / 永久）',
      desc: 'POST /api/mailboxes — address、domain、permanent、auto_subdomain、subdomain_mode 均可选；若地址是 catch-all 暂存地址，响应会返回 claimed=true',
      code: `# 随机地址 + 随机域名
curl -s -X POST ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{}'

# 指定本地部分（@ 之前），域名随机
curl -s -X POST ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "mytestbox"}'

# 指定域名，地址随机（domain 须是已激活域名）
curl -s -X POST ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"domain": "example.com"}'

# 同时指定地址和域名
curl -s -X POST ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "mytestbox", "domain": "example.com"}'

# 创建永久邮箱（普通用户受永久额度限制，管理员无限制）
curl -s -X POST ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "vipbox", "domain": "example.com", "permanent": true}'

# 在通配规则 *.example.com 下创建真实子域邮箱
curl -s -X POST ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "hello", "domain": "demo.example.com"}'

# 使用一个普通子域名作为精确收件域
curl -s -X POST ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "ops", "domain": "mail.example.net"}'

# 在通配规则 *.example.com 下自动分配随机真实子域
curl -s -X POST ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "hello", "domain": "*.example.com", "auto_subdomain": true, "subdomain_mode": "random"}'

# 在通配规则 *.example.com 下按词库随机分配真实子域
curl -s -X POST ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "hello", "domain": "*.example.com", "auto_subdomain": true, "subdomain_mode": "wordlist"}'

# 在 *.mail.example.net 下自动分配随机真实子域
curl -s -X POST ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "hello", "domain": "*.mail.example.net", "auto_subdomain": true}'

# 响应中会额外带上 auto_subdomain=true、subdomain_mode 和 generated_domain
# random 示例：hello@k8m2p4xz.example.com
# wordlist 示例：hello@support-center.example.com
# wordlist 词库可在后台“系统设置”里直接编辑

# 错误码：
#   400 → domain 不存在或未激活
#   403 → 地址前缀属于管理员保留地址（如 admin / noreply）
#   201 + claimed=true → 已认领 catch-all 地址
#   409 → 地址已被占用，或普通用户永久邮箱额度已用完
#   503 → 系统内无可用域名`,
    },
    {
      title: '🌍 域名提交 / MX 验证',
      desc: 'POST /api/domains/submit — 登录用户可提交根域、普通子域或 wildcard 规则，系统会自动检查 MX 并异步激活。',
      code: `# 提交根域
curl -s -X POST ${base}/api/domains/submit \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"domain": "example.com"}'

# 提交普通子域（不是根域也可以）
curl -s -X POST ${base}/api/domains/submit \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"domain": "mail.example.net"}'

# 提交通配规则
curl -s -X POST ${base}/api/domains/submit \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"domain": "*.example.com"}'

# 提交子域上的通配规则
curl -s -X POST ${base}/api/domains/submit \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"domain": "*.mail.example.net"}'

# 查询状态
curl -s ${base}/api/domains/<domain-id>/status \\
  -H "Authorization: Bearer ${key}"`,
    },
    {
      title: '📌 2. 获取邮箱列表',
      desc: 'GET /api/mailboxes — 获取当前账号下所有邮箱',
      code: `curl -s ${base}/api/mailboxes \\
  -H "Authorization: Bearer ${key}"

# 分页
 curl -s "${base}/api/mailboxes?page=1&size=20" \\
  -H "Authorization: Bearer ${key}"`,
    },
    {
      title: '📥 3. 获取邮箱收件箱（邮件列表）',
      desc: 'GET /api/mailboxes/:id/emails — 按收件时间倒序列出邮件摘要',
      code: `MAILBOX_ID="你的邮箱UUID"
curl -s ${base}/api/mailboxes/$MAILBOX_ID/emails \\
  -H "Authorization: Bearer ${key}"

# 分页
curl -s "${base}/api/mailboxes/$MAILBOX_ID/emails?page=1&size=20" \\
  -H "Authorization: Bearer ${key}"`,
    },
    {
      title: '📝 4. 读取单封邮件',
      desc: 'GET /api/mailboxes/:id/emails/:email_id — 获取邮件完整内容（含 HTML/纯文本和原始数据）',
      code: `MAILBOX_ID="你的邮箱UUID"
EMAIL_ID="你的邮件UUID"
curl -s ${base}/api/mailboxes/$MAILBOX_ID/emails/$EMAIL_ID \\
  -H "Authorization: Bearer ${key}"`,
    },
    {
      title: '🗑 5. 删除邮箱',
      desc: 'DELETE /api/mailboxes/:id — 立即删除邮箱及其所有邮件',
      code: `MAILBOX_ID="你的邮箱UUID"
curl -s -X DELETE ${base}/api/mailboxes/$MAILBOX_ID \\
  -H "Authorization: Bearer ${key}"`,
    },
    {
      title: '🗑 6. 删除单封邮件',
      desc: 'DELETE /api/mailboxes/:id/emails/:email_id',
      code: `curl -s -X DELETE ${base}/api/mailboxes/$MAILBOX_ID/emails/$EMAIL_ID \\
  -H "Authorization: Bearer ${key}"`,
    },
    {
      title: '🧪 7. 完整自动化示例（Shell 脚本）',
      desc: '创建邮箱 → 等待 5 秒 → 读取邮件 → 清理',
      code: `#!/bin/bash
BASE="${base}"
KEY="${key}"

# 1. 创建临时邮箱
MB=$(curl -s -X POST $BASE/api/mailboxes \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{}')
MB_ID=$(echo $MB | python3 -c "import sys,json; print(json.load(sys.stdin)['mailbox']['id'])")
MB_ADDR=$(echo $MB | python3 -c "import sys,json; print(json.load(sys.stdin)['mailbox']['full_address'])")
echo "✓ 邮箱: $MB_ADDR (主键: $MB_ID)"

# 2. 向邮箱发送邮件...
echo "将测试邮件发到: $MB_ADDR"
sleep 5

# 3. 查看收件筱
EMAILS=$(curl -s $BASE/api/mailboxes/$MB_ID/emails \\
  -H "Authorization: Bearer $KEY")
echo "取到邮件: $EMAILS" | python3 -m json.tool

# 4. 读取第一封邮件（收件箱）
EMAIL_ID=$(echo $EMAILS | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['data'][0]['id']) if d.get('data') else print('')" 2>/dev/null)
if [ -n "$EMAIL_ID" ]; then
  curl -s $BASE/api/mailboxes/$MB_ID/emails/$EMAIL_ID \\
    -H "Authorization: Bearer $KEY" | python3 -m json.tool
fi

# 5. 删除邮箱
curl -s -X DELETE $BASE/api/mailboxes/$MB_ID \\
  -H "Authorization: Bearer $KEY"
echo "✓ 邮箱已删除"`,
    },
    {
      title: '👑 8. 管理员：切换账户管理员身份',
      desc: 'PUT /api/admin/accounts/:id/admin',
      code: `ACCOUNT_ID="目标账户UUID"
curl -s -X PUT ${base}/api/admin/accounts/$ACCOUNT_ID/admin \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"is_admin": true}'

# 解除管理员
curl -s -X PUT ${base}/api/admin/accounts/$ACCOUNT_ID/admin \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"is_admin": false}'`,
    },
    {
      title: '🧮 9. 管理员：调整普通用户永久邮箱额度',
      desc: 'PUT /api/admin/accounts/:id/quota',
      code: `ACCOUNT_ID="目标账户UUID"
curl -s -X PUT ${base}/api/admin/accounts/$ACCOUNT_ID/quota \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"permanent_mailbox_quota": 12}'`,
    },
    {
      title: '📥 10. 管理员：Catch-all 收件箱',
      desc: '查看所有未预创建地址生成的 catch-all 邮箱及邮件',
      code: `# 列出所有 catch-all 邮箱
curl -s ${base}/api/admin/catchall/mailboxes \\
  -H "Authorization: Bearer ${key}"

MAILBOX_ID="catch-all 邮箱UUID"

# 查看该地址下的邮件列表
curl -s ${base}/api/admin/catchall/mailboxes/$MAILBOX_ID/emails \\
  -H "Authorization: Bearer ${key}"

EMAIL_ID="邮件UUID"

# 查看单封邮件
curl -s ${base}/api/admin/catchall/mailboxes/$MAILBOX_ID/emails/$EMAIL_ID \\
  -H "Authorization: Bearer ${key}"

# 删除整条 catch-all 地址及其邮件
curl -s -X DELETE ${base}/api/admin/catchall/mailboxes/$MAILBOX_ID \\
  -H "Authorization: Bearer ${key}"`,
    },
    {
      title: '⚙ 11. 管理员：Catch-all / 保留地址设置',
      desc: '通过系统设置切换弱所有权 / 管理员专属模式，指定接收管理员，或配置普通用户不可注册的保留地址',
      code: `# 弱所有权模式：未知地址进入系统 _catchall，可被后续认领
curl -s -X PUT ${base}/api/admin/settings \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"unknown_recipient_policy":"claimable","catchall_admin_account_id":""}'

# 管理员专属模式：指定某个管理员作为 catch-all 接收者
curl -s -X PUT ${base}/api/admin/settings \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"unknown_recipient_policy":"admin_only","catchall_admin_account_id":"<admin-uuid>"}'

# 配置普通用户不可创建的保留地址（仅管理员可注册）
curl -s -X PUT ${base}/api/admin/settings \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"reserved_mailbox_addresses":"admin\\nnoreply\\npostmaster\\nsecurity"}'`,
    },
    {
      title: '📈 12. 并发压测示例（wrk）',
      desc: '对注册接口进行高并发压测，500 并发，持续 30 秒',
      code: `# 安装 wrk: apt install wrk

# 导出注册脚本
cat > /tmp/register.lua << 'EOF'
wrk.method = "POST"
wrk.body   = '{"username": "user_' .. math.random(100000,999999) .. '"}'
wrk.headers["Content-Type"] = "application/json"
EOF

# 运行压测
wrk -t 10 -c 500 -d 30s --script /tmp/register.lua \\
  ${base}/public/register

# 或使用 k6
cat > /tmp/test.js << 'EOF'
import http from 'k6/http';
import { check } from 'k6';
export const options = { vus: 500, duration: '30s' };
const KEY = '${key}';
export default function() {
  const r = http.post(
    '${base}/api/mailboxes',
    '{}',
    { headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }}
  );
  check(r, { '创建成功': r => r.status === 201 });
}
EOF
k6 run /tmp/test.js`,
    },
  ];

  container.innerHTML = `
    <div style="max-width:860px">
      <div style="margin-bottom:1.2rem;padding:0.8rem 1rem;background:var(--bg-secondary);border-radius:8px;font-size:0.82rem">
        🔑 当前 API Key：
        <code style="margin-left:0.5rem;filter:blur(3px);cursor:pointer" onclick="this.style.filter='none'">${escHtml(key)}</code>
        <button class="copy-btn" onclick="copyText('${escHtml(key)}')" title="复制">⎘</button>
      </div>
      ${sections.map((s,i) => `
        <div class="card" style="margin-bottom:1rem">
          <div class="card-header"><div class="card-title">${escHtml(s.title)}</div></div>
          <div class="card-body">
            <p style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:0.6rem">${escHtml(s.desc)}</p>
            <div class="code-box" style="white-space:pre;overflow-x:auto;font-size:0.75rem;line-height:1.6;position:relative">
              <button class="copy-btn" style="position:absolute;top:6px;right:6px" onclick="copyText(${JSON.stringify(s.code)})" title="复制">⎘</button>
              ${escHtml(s.code)}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ─── 启动 ──────────────────────────────────────────────────
async function init() {
  applyTheme(state.theme, { persist: false });
  await loadPublicSettings();

  if (state.apiKey && state.account) {
    showMainLayout();
    navigate('dashboard');
  } else if (state.apiKey) {
    // 验证 key
    tryLogin(state.apiKey);
  } else {
    showAuthPage();
  }
}

document.addEventListener('DOMContentLoaded', init);
