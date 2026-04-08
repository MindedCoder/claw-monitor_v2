const directoryCache = new Map();
const fileMetaCache = new Map();
const fileContentCache = new Map();
const pendingDirectoryRequests = new Map();
const pendingFileRequests = new Map();
let activeDirectoryId = 'root';
let activeFileId = null;
let lastMatchState = null;
let returnToMatchResults = false;
let smartMatchDebounceTimer = null;
let latestMatchRequestId = 0;
const FILE_SEARCH_MIN_QUERY_LENGTH = 2;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

function getBasePath() {
  const pathname = window.location.pathname || '/';
  const normalizedPath = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const marker = '/filedeck';
  const index = normalizedPath.lastIndexOf(marker);
  if (index === -1) {
    return '';
  }
  return normalizedPath.slice(0, index + marker.length);
}

function resolveServiceUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getBasePath()}${normalizedPath}`;
}

async function ensureDirectoryLoaded(id) {
  if (directoryCache.has(id)) {
    return directoryCache.get(id);
  }

  if (pendingDirectoryRequests.has(id)) {
    return pendingDirectoryRequests.get(id);
  }

  const url = id === 'root'
    ? resolveServiceUrl('/api/tree')
    : resolveServiceUrl('/api/node?id=' + encodeURIComponent(id));
  const request = fetchJson(url)
    .then((directory) => {
      directoryCache.set(directory.id, directory);
      for (const child of directory.children || []) {
        if (child.type === 'file') {
          fileMetaCache.set(child.id, child);
        }
      }
      pendingDirectoryRequests.delete(id);
      return directory;
    })
    .catch((error) => {
      pendingDirectoryRequests.delete(id);
      throw error;
    });

  pendingDirectoryRequests.set(id, request);
  return request;
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function markdownToHtml(markdown) {
  const lines = markdown.split('\n');
  const parts = [];
  let inCodeBlock = false;
  let codeBuffer = [];

  function closeCodeBlock() {
    if (!inCodeBlock) {
      return;
    }
    parts.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
    inCodeBlock = false;
    codeBuffer = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        closeCodeBlock();
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      parts.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^[-*]\s+(.*)$/);
    if (unordered) {
      parts.push(`<p>• ${inlineMarkdown(unordered[1])}</p>`);
      continue;
    }
    parts.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  closeCodeBlock();
  return parts.join('');
}

function openDrawer() {
  document.getElementById('drawer-overlay').classList.add('open');
  document.getElementById('preview-drawer').classList.add('open');
  document.getElementById('preview-drawer').setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  document.getElementById('drawer-overlay').classList.remove('open');
  document.getElementById('preview-drawer').classList.remove('open');
  document.getElementById('preview-drawer').setAttribute('aria-hidden', 'true');
}

function setDrawerHeader(file) {
  const actions = document.getElementById('drawer-actions');
  actions.innerHTML = '';

  const copyPathButton = document.createElement('button');
  copyPathButton.type = 'button';
  copyPathButton.className = 'action';
  copyPathButton.textContent = '复制路径';
  copyPathButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(file.copyPath || '');
      copyPathButton.textContent = '已复制';
      window.setTimeout(() => {
        copyPathButton.textContent = '复制路径';
      }, 1200);
    } catch (error) {
      copyPathButton.textContent = '复制失败';
      window.setTimeout(() => {
        copyPathButton.textContent = '复制路径';
      }, 1200);
    }
  });

  const downloadLink = document.createElement('a');
  downloadLink.className = 'action';
  downloadLink.href = file.rawUrl;
  downloadLink.download = file.name;
  downloadLink.textContent = '下载文件';

  actions.appendChild(copyPathButton);
  actions.appendChild(downloadLink);
}

function renderDrawerBody(file) {
  const drawerBody = document.getElementById('drawer-body');

  if (file.previewKind === 'json') {
    let formatted = file.content;
    try {
      formatted = JSON.stringify(JSON.parse(file.content), null, 2);
    } catch (_error) {
    }
    drawerBody.innerHTML = `<pre>${escapeHtml(formatted)}</pre>`;
    return;
  }

  if (file.previewKind === 'markdown') {
    const note = file.truncated ? '<p class="meta">内容过大，当前只显示前 1MB。</p>' : '';
    drawerBody.innerHTML = `${note}<article class="markdown">${markdownToHtml(file.content)}</article>`;
    return;
  }

  if (file.previewKind === 'text') {
    const note = file.truncated ? '<div class="meta" style="margin-bottom:12px;">内容过大，当前只显示前 1MB。</div>' : '';
    drawerBody.innerHTML = `${note}<pre>${escapeHtml(file.content)}</pre>`;
    return;
  }

  if (file.previewKind === 'pdf') {
    drawerBody.innerHTML = `<iframe class="viewer-frame" src="${file.rawUrl}" title="${escapeHtml(file.name)}"></iframe>`;
    return;
  }

  if (file.previewKind === 'image') {
    drawerBody.innerHTML = `<img class="image-preview" src="${file.rawUrl}" alt="${escapeHtml(file.name)}" />`;
    return;
  }

  drawerBody.innerHTML = '<div class="empty">这个文件类型暂不支持内嵌预览，请点击“下载文件”。</div>';
}

function renderDirectory(directory) {
  const entries = document.getElementById('entries');
  const currentPath = document.getElementById('current-path');
  const backButton = document.getElementById('back-button');
  const browserCard = document.getElementById('browser-card');
  const children = directory.children || [];

  document.getElementById('match-results').innerHTML = '';
  if (!returnToMatchResults) {
    lastMatchState = null;
  }
  browserCard.classList.remove('hidden');
  currentPath.innerHTML = '';
  for (let index = 0; index < directory.breadcrumb.length; index += 1) {
    const item = directory.breadcrumb[index];
    const isCurrent = index === directory.breadcrumb.length - 1;
    const node = document.createElement(isCurrent ? 'span' : 'button');
    node.textContent = item.name;
    node.className = isCurrent ? 'path-current' : 'path-link';

    if (!isCurrent) {
      node.type = 'button';
      node.addEventListener('click', () => navigateTo(item.id));
    }

    currentPath.appendChild(node);

    if (!isCurrent) {
      const separator = document.createElement('span');
      separator.className = 'path-separator';
      separator.textContent = '/';
      currentPath.appendChild(separator);
    }
  }

  backButton.disabled = directory.breadcrumb.length <= 1;
  backButton.style.opacity = directory.breadcrumb.length <= 1 ? '0.45' : '1';
  backButton.onclick = () => {
    if (returnToMatchResults && lastMatchState) {
      restoreMatchResults();
      return;
    }
    if (directory.breadcrumb.length > 1) {
      navigateTo(directory.breadcrumb[directory.breadcrumb.length - 2].id);
    }
  };

  entries.innerHTML = '';
  if (!children.length) {
    entries.innerHTML = '<div class="empty">这个目录下没有内容。</div>';
    return;
  }

  for (const child of children) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'entry' + (child.id === activeFileId ? ' active' : '');
    card.addEventListener('click', async (event) => {
      event.preventDefault();
      if (child.type === 'directory') {
        await navigateTo(child.id);
      } else {
        await previewFile(child.id);
      }
    });

    const top = document.createElement('div');
    top.className = 'entry-top';

    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.textContent = child.type === 'directory' ? '📁' : '📄';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = child.name;

    top.appendChild(icon);
    top.appendChild(name);

    if (child.type === 'directory') {
      const count = document.createElement('div');
      count.className = 'entry-count';
      count.textContent = `${child.itemCount ?? 0} 项`;
      top.appendChild(count);
    }

    card.appendChild(top);
    entries.appendChild(card);
  }
}

async function previewFile(id) {
  activeFileId = id;
  const activeDirectory = directoryCache.get(activeDirectoryId);
  if (activeDirectory) {
    renderDirectory(activeDirectory);
  }

  openDrawer();
  document.getElementById('drawer-actions').innerHTML = '';
  document.getElementById('drawer-body').innerHTML = '<div class="loading">正在读取文件...</div>';

  try {
    if (!pendingFileRequests.has(id) && !fileContentCache.has(id)) {
      pendingFileRequests.set(
        id,
        fetchJson(resolveServiceUrl('/api/file?id=' + encodeURIComponent(id)))
          .then((file) => {
            fileContentCache.set(id, file);
            pendingFileRequests.delete(id);
            return file;
          })
          .catch((error) => {
            pendingFileRequests.delete(id);
            throw error;
          })
      );
    }

    const file = fileContentCache.get(id) || await pendingFileRequests.get(id);
    setDrawerHeader(file);
    renderDrawerBody(file);
  } catch (error) {
    document.getElementById('drawer-actions').innerHTML = '';
    document.getElementById('drawer-body').innerHTML = `<div class="empty">${escapeHtml(error.message || '文件读取失败')}</div>`;
  }
}

async function navigateTo(id) {
  const entries = document.getElementById('entries');
  entries.innerHTML = '<div class="loading">正在加载目录...</div>';
  activeDirectoryId = id;
  activeFileId = null;
  try {
    const directory = await ensureDirectoryLoaded(id);
    renderDirectory(directory);
  } catch (error) {
    entries.innerHTML = `<div class="empty">${escapeHtml(error.message || '目录加载失败')}</div>`;
  }
}

function isDrawerOpen() {
  return document.getElementById('preview-drawer').classList.contains('open');
}

function goBack() {
  if (isDrawerOpen()) {
    closeDrawer();
    return;
  }
  if (returnToMatchResults && lastMatchState) {
    restoreMatchResults();
    return;
  }
  const browserCard = document.getElementById('browser-card');
  if (browserCard.classList.contains('hidden')) {
    restoreMatchResults();
    return;
  }
  const directory = directoryCache.get(activeDirectoryId);
  if (directory && directory.breadcrumb && directory.breadcrumb.length > 1) {
    navigateTo(directory.breadcrumb[directory.breadcrumb.length - 2].id);
  }
}

function restoreMatchResults() {
  const browserCard = document.getElementById('browser-card');
  browserCard.classList.add('hidden');
  if (lastMatchState) {
    returnToMatchResults = false;
    renderMatchResults(lastMatchState.text, lastMatchState.matches);
    return;
  }
  document.getElementById('match-results').innerHTML = '';
  browserCard.classList.remove('hidden');
}

function closeMatchResults() {
  returnToMatchResults = false;
  lastMatchState = null;
  document.getElementById('match-results').innerHTML = '';
  document.getElementById('browser-card').classList.remove('hidden');
}

function renderMatchResults(text, matches) {
  const matchResults = document.getElementById('match-results');
  const browserCard = document.getElementById('browser-card');
  const resultTitle = matches.length && matches[0].searchKind === 'file-search'
    ? '文件名搜索结果'
    : '识别结果';
  lastMatchState = { text, matches };
  returnToMatchResults = false;
  browserCard.classList.add('hidden');
  matchResults.innerHTML = '';

  const items = matches.length
    ? matches
    : [{ type: 'empty', displayPath: '未识别到匹配的路径。' }];

  items.forEach((item, index) => {
    const card = document.createElement('section');
    card.className = 'card browser';

    if (index === 0) {
      const head = document.createElement('div');
      head.className = 'section-head';

      const title = document.createElement('h2');
      title.className = 'section-title';
      title.textContent = resultTitle;

      const actions = document.createElement('div');
      actions.className = 'head-actions';

      const backButton = document.createElement('button');
      backButton.type = 'button';
      backButton.className = 'back-button';
      backButton.textContent = '返回上一级';
      backButton.addEventListener('click', closeMatchResults);

      actions.appendChild(backButton);
      head.appendChild(title);
      head.appendChild(actions);
      card.appendChild(head);

      const summary = document.createElement('div');
      summary.className = 'path';
      summary.textContent = text;
      card.appendChild(summary);
    }

    const list = document.createElement('div');
    list.className = 'folder-grid';

    if (item.type === 'empty') {
      list.innerHTML = `<div class="empty">${escapeHtml(item.displayPath)}</div>`;
    } else {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'entry';

      const top = document.createElement('div');
      top.className = 'entry-top';

      const icon = document.createElement('div');
      icon.className = 'icon';
      icon.textContent = item.type === 'directory' ? '📁' : '📄';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name || item.displayPath;

      top.appendChild(icon);
      top.appendChild(name);
      entry.appendChild(top);

      const meta = document.createElement('div');
      meta.className = 'path';
      meta.textContent = item.displayPath;
      entry.appendChild(meta);

      entry.addEventListener('click', async () => {
        returnToMatchResults = true;
        matchResults.innerHTML = '';
        browserCard.classList.remove('hidden');
        if (item.type === 'directory') {
          await navigateTo(item.id);
        } else {
          await navigateTo(item.parentId);
          await previewFile(item.id);
        }
      });

      list.appendChild(entry);
    }

    card.appendChild(list);
    matchResults.appendChild(card);
  });
}

async function doMatch(text) {
  const requestId = ++latestMatchRequestId;
  const matchResults = document.getElementById('match-results');
  const browserCard = document.getElementById('browser-card');
  browserCard.classList.add('hidden');
  matchResults.innerHTML = `
    <section class="card browser">
      <div class="section-head">
        <h2 class="section-title">识别结果</h2>
        <div class="head-actions">
          <button class="back-button" id="inline-match-back" type="button">返回上一级</button>
        </div>
      </div>
      <div class="path">${escapeHtml(text)}</div>
      <div class="folder-grid">
        <div class="loading">正在识别路径...</div>
      </div>
    </section>
  `;
  document.getElementById('inline-match-back').addEventListener('click', closeMatchResults);

  try {
    const response = await fetch(resolveServiceUrl('/api/match-paths'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await response.json();
    if (requestId !== latestMatchRequestId) {
      return;
    }

    if (Array.isArray(data.matches) && data.matches.length) {
      renderMatchResults(
        text,
        data.matches.map((item) => ({ ...item, searchKind: 'path-match' }))
      );
      return;
    }

    if (text.trim().length < FILE_SEARCH_MIN_QUERY_LENGTH) {
      renderMatchResults(text, []);
      return;
    }

    const fileData = await fetchJson(
      resolveServiceUrl('/api/search-files?q=' + encodeURIComponent(text.trim()))
    );
    if (requestId !== latestMatchRequestId) {
      return;
    }
    renderMatchResults(
      text,
      (fileData.matches || []).map((item) => ({ ...item, searchKind: 'file-search' }))
    );
  } catch (error) {
    if (requestId !== latestMatchRequestId) {
      return;
    }
    renderMatchResults(text, [{ type: 'empty', displayPath: error.message || '识别失败' }]);
  }
}

async function submitSmartMatchInput() {
  const input = document.getElementById('smart-match-input');
  const text = input.value;
  if (!text || !text.trim()) {
    closeMatchResults();
    return;
  }

  await doMatch(text);
}

function clearSmartMatchInput() {
  const input = document.getElementById('smart-match-input');
  input.value = '';
  if (smartMatchDebounceTimer) {
    window.clearTimeout(smartMatchDebounceTimer);
    smartMatchDebounceTimer = null;
  }
  latestMatchRequestId += 1;
  closeMatchResults();
  input.focus();
}

function scheduleSmartMatch() {
  const input = document.getElementById('smart-match-input');
  const text = input.value;

  if (smartMatchDebounceTimer) {
    window.clearTimeout(smartMatchDebounceTimer);
  }

  if (!text || !text.trim()) {
    latestMatchRequestId += 1;
    closeMatchResults();
    return;
  }

  smartMatchDebounceTimer = window.setTimeout(() => {
    smartMatchDebounceTimer = null;
    void doMatch(input.value);
  }, 300);
}

function initSwipeBack() {
  const minDistance = 80;
  let startX = 0;
  let startY = 0;

  document.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = Math.abs(e.changedTouches[0].clientY - startY);
    if (Math.abs(dx) > minDistance && dy < Math.abs(dx) * 0.5) {
      goBack();
    }
  }, { passive: true });
}

async function boot() {
  try {
    document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);
    document.getElementById('drawer-close').addEventListener('click', closeDrawer);
    document.getElementById('smart-match-submit').addEventListener('click', clearSmartMatchInput);
    document.getElementById('smart-match-input').addEventListener('input', scheduleSmartMatch);
    initSwipeBack();
    const rootDirectory = await ensureDirectoryLoaded('root');
    if (rootDirectory) {
      document.getElementById('app-title').textContent = rootDirectory.name;
      document.title = `${rootDirectory.name} Viewer`;
      if (rootDirectory.defaultDirectoryId && rootDirectory.defaultDirectoryId !== rootDirectory.id) {
        await navigateTo(rootDirectory.defaultDirectoryId);
      } else {
        activeDirectoryId = rootDirectory.id;
        renderDirectory(rootDirectory);
      }
    }
  } catch (error) {
    document.getElementById('entries').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

boot();
