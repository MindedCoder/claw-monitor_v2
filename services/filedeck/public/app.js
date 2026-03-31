const directoryCache = new Map();
const fileMetaCache = new Map();
const fileContentCache = new Map();
const pendingDirectoryRequests = new Map();
const pendingFileRequests = new Map();
let activeDirectoryId = 'root';
let activeFileId = null;

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

async function ensureDirectoryLoaded(id) {
  if (directoryCache.has(id)) {
    return directoryCache.get(id);
  }

  if (pendingDirectoryRequests.has(id)) {
    return pendingDirectoryRequests.get(id);
  }

  const url = id === 'root' ? 'api/tree' : 'api/node?id=' + encodeURIComponent(id);
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
  const children = directory.children || [];

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
    card.addEventListener('click', async () => {
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
        fetchJson('api/file?id=' + encodeURIComponent(id))
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
  const directory = await ensureDirectoryLoaded(id);
  renderDirectory(directory);
}

async function boot() {
  try {
    document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);
    document.getElementById('drawer-close').addEventListener('click', closeDrawer);
    await navigateTo('root');
    const rootDirectory = directoryCache.get('root');
    if (rootDirectory) {
      document.getElementById('app-title').textContent = rootDirectory.name;
      document.title = `${rootDirectory.name} Viewer`;
    }
  } catch (error) {
    document.getElementById('entries').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

boot();
